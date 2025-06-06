import { format } from 'util';
import * as cfnDiff from '@aws-cdk/cloudformation-diff';
import type { ResourceDifference } from '@aws-cdk/cloudformation-diff';
import type * as cxapi from '@aws-cdk/cx-api';
import type { ResourceIdentifierSummary, ResourceToImport } from '@aws-sdk/client-cloudformation';
import * as chalk from 'chalk';
import * as fs from 'fs-extra';
import type { DeploymentMethod } from '../../actions/deploy';
import { ToolkitError } from '../../toolkit/toolkit-error';
import type { Deployments } from '../deployments';
import { assertIsSuccessfulDeployStackResult } from '../deployments';
import { IO, type IoHelper } from '../io/private';
import type { Tag } from '../tags';

export type ResourcesToImport = ResourceToImport[];
export type ResourceIdentifierSummaries = ResourceIdentifierSummary[];

export interface ResourceImporterProps {
  deployments: Deployments;
  ioHelper: IoHelper;
}

export interface ImportDeploymentOptions {
  /**
   * Role to pass to CloudFormation for deployment
   *
   * @default - Default stack role
   */
  readonly roleArn?: string;

  /**
   * Deployment method
   *
   * @default - Change set with default options
   */
  readonly deploymentMethod?: DeploymentMethod;

  /**
   * Stack tags (pass through to CloudFormation)
   *
   * @default - No tags
   */
  readonly tags?: Tag[];

  /**
   * Use previous values for unspecified parameters
   *
   * If not set, all parameters must be specified for every deployment.
   *
   * @default true
   */
  readonly usePreviousParameters?: boolean;

  /**
   * Rollback failed deployments
   *
   * @default true
   */
  readonly rollback?: boolean;
}

/**
 * Set of parameters that uniquely identify a physical resource of a given type
 * for the import operation, example:
 *
 * ```
 * {
 *   "AWS::S3::Bucket": [["BucketName"]],
 *   "AWS::DynamoDB::GlobalTable": [["TableName"], ["TableArn"], ["TableStreamArn"]],
 *   "AWS::Route53::KeySigningKey": [["HostedZoneId", "Name"]],
 * }
 * ```
 */
export type ResourceIdentifiers = { [resourceType: string]: string[][] };

type ResourceIdentifierProperties = Record<string, string>;

/**
 * Mapping of CDK resources (L1 constructs) to physical resources to be imported
 * in their place, example:
 *
 * ```
 * {
 *   "MyStack/MyS3Bucket/Resource": {
 *     "BucketName": "my-manually-created-s3-bucket"
 *   },
 *   "MyStack/MyVpc/Resource": {
 *     "VpcId": "vpc-123456789"
 *   }
 * }
 * ```
 */
type ResourceMap = { [logicalResource: string]: ResourceIdentifierProperties };

/**
 * Resource importing utility class
 *
 * - Determines the resources added to a template (compared to the deployed version)
 * - Look up the identification information
 *   - Load them from a file, or
 *   - Ask the user, based on information supplied to us by CloudFormation's GetTemplateSummary
 * - Translate the input to a structure expected by CloudFormation, update the template to add the
 *   importable resources, then run an IMPORT changeset.
 */
export class ResourceImporter {
  private _currentTemplate: any;

  private readonly stack: cxapi.CloudFormationStackArtifact;
  private readonly cfn: Deployments;
  private readonly ioHelper: IoHelper;

  constructor(
    stack: cxapi.CloudFormationStackArtifact,
    props: ResourceImporterProps,
  ) {
    this.stack = stack;
    this.cfn = props.deployments;
    this.ioHelper = props.ioHelper;
  }

  /**
   * Ask the user for resources to import
   */
  public async askForResourceIdentifiers(available: ImportableResource[]): Promise<ImportMap> {
    const ret: ImportMap = { importResources: [], resourceMap: {} };
    const resourceIdentifiers = await this.resourceIdentifiers();

    for (const resource of available) {
      const identifier = await this.askForResourceIdentifier(resourceIdentifiers, resource);
      if (!identifier) {
        continue;
      }

      ret.importResources.push(resource);
      ret.resourceMap[resource.logicalId] = identifier;
    }

    return ret;
  }

  /**
   * Load the resources to import from a file
   */
  public async loadResourceIdentifiers(available: ImportableResource[], filename: string): Promise<ImportMap> {
    const contents = await fs.readJson(filename);

    const ret: ImportMap = { importResources: [], resourceMap: {} };
    for (const resource of available) {
      const descr = this.describeResource(resource.logicalId);
      const idProps = contents[resource.logicalId];
      if (idProps) {
        await this.ioHelper.defaults.info(format('%s: importing using %s', chalk.blue(descr), chalk.blue(fmtdict(idProps))));

        ret.importResources.push(resource);
        ret.resourceMap[resource.logicalId] = idProps;
        delete contents[resource.logicalId];
      } else {
        await this.ioHelper.defaults.info(format('%s: skipping', chalk.blue(descr)));
      }
    }

    const unknown = Object.keys(contents);
    if (unknown.length > 0) {
      await this.ioHelper.defaults.warn(`Unrecognized resource identifiers in mapping file: ${unknown.join(', ')}`);
    }

    return ret;
  }

  /**
   * Based on the provided resource mapping, prepare CFN structures for import (template,
   * ResourcesToImport structure) and perform the import operation (CloudFormation deployment)
   *
   * @param importMap - Mapping from CDK construct tree path to physical resource import identifiers
   * @param options - Options to pass to CloudFormation deploy operation
   */
  public async importResourcesFromMap(importMap: ImportMap, options: ImportDeploymentOptions = {}) {
    const resourcesToImport: ResourcesToImport = await this.makeResourcesToImport(importMap);
    const updatedTemplate = await this.currentTemplateWithAdditions(importMap.importResources);

    await this.importResources(updatedTemplate, resourcesToImport, options);
  }

  /**
   * Based on the app and resources file generated by cdk migrate. Removes all items from the template that
   * cannot be included in an import change-set for new stacks and performs the import operation,
   * creating the new stack.
   *
   * @param resourcesToImport - The mapping created by cdk migrate
   * @param options - Options to pass to CloudFormation deploy operation
   */
  public async importResourcesFromMigrate(resourcesToImport: ResourcesToImport, options: ImportDeploymentOptions = {}) {
    const updatedTemplate = this.removeNonImportResources();

    await this.importResources(updatedTemplate, resourcesToImport, options);
  }

  private async importResources(overrideTemplate: any, resourcesToImport: ResourcesToImport, options: ImportDeploymentOptions) {
    try {
      const result = await this.cfn.deployStack({
        stack: this.stack,
        deployName: this.stack.stackName,
        ...options,
        overrideTemplate,
        resourcesToImport,
      });

      assertIsSuccessfulDeployStackResult(result);

      const message = result.noOp
        ? ' ✅  %s (no changes)'
        : ' ✅  %s';

      await this.ioHelper.defaults.info('\n' + chalk.green(format(message, this.stack.displayName)));
    } catch (e) {
      await this.ioHelper.notify(IO.CDK_TOOLKIT_E3900.msg(format('\n ❌  %s failed: %s', chalk.bold(this.stack.displayName), e), { error: e as any }));
      throw e;
    }
  }

  /**
   * Perform a diff between the currently running and the new template, ensure that it is valid
   * for importing and return a list of resources that are being added in the new version
   *
   * @return mapping logicalResourceId -> resourceDifference
   */
  public async discoverImportableResources(allowNonAdditions = false): Promise<DiscoverImportableResourcesResult> {
    const currentTemplate = await this.currentTemplate();

    const diff = cfnDiff.fullDiff(currentTemplate, this.stack.template);

    // Ignore changes to CDKMetadata
    const resourceChanges = Object.entries(diff.resources.changes)
      .filter(([logicalId, _]) => logicalId !== 'CDKMetadata');

    // Split the changes into additions and non-additions. Imports only make sense
    // for newly-added resources.
    const nonAdditions = resourceChanges.filter(([_, dif]) => !dif.isAddition);
    const additions = resourceChanges.filter(([_, dif]) => dif.isAddition);

    if (nonAdditions.length) {
      const offendingResources = nonAdditions.map(([logId, _]) => this.describeResource(logId));

      if (allowNonAdditions) {
        await this.ioHelper.defaults.warn(`Ignoring updated/deleted resources (--force): ${offendingResources.join(', ')}`);
      } else {
        throw new ToolkitError('No resource updates or deletes are allowed on import operation. Make sure to resolve pending changes ' +
          `to existing resources, before attempting an import. Updated/deleted resources: ${offendingResources.join(', ')} (--force to override)`);
      }
    }

    // Resources in the new template, that are not present in the current template, are a potential import candidates
    return {
      additions: additions.map(([logicalId, resourceDiff]) => ({
        logicalId,
        resourceDiff,
        resourceDefinition: addDefaultDeletionPolicy(this.stack.template?.Resources?.[logicalId] ?? {}),
      })),
      hasNonAdditions: nonAdditions.length > 0,
    };
  }

  /**
   * Resolves the environment of a stack.
   */
  public async resolveEnvironment(): Promise<cxapi.Environment> {
    return this.cfn.resolveEnvironment(this.stack);
  }

  /**
   * Get currently deployed template of the given stack (SINGLETON)
   *
   * @returns Currently deployed CloudFormation template
   */
  private async currentTemplate(): Promise<any> {
    if (!this._currentTemplate) {
      this._currentTemplate = await this.cfn.readCurrentTemplate(this.stack);
    }
    return this._currentTemplate;
  }

  /**
   * Return the current template, with the given resources added to it
   */
  private async currentTemplateWithAdditions(additions: ImportableResource[]): Promise<any> {
    const template = await this.currentTemplate();
    if (!template.Resources) {
      template.Resources = {};
    }

    for (const add of additions) {
      template.Resources[add.logicalId] = add.resourceDefinition;
    }

    return template;
  }

  /**
   * Get a list of import identifiers for all resource types used in the given
   * template that do support the import operation (SINGLETON)
   *
   * @returns a mapping from a resource type to a list of property names that together identify the resource for import
   */
  private async resourceIdentifiers(): Promise<ResourceIdentifiers> {
    const ret: ResourceIdentifiers = {};
    const resourceIdentifierSummaries = await this.cfn.resourceIdentifierSummaries(this.stack);
    for (const summary of resourceIdentifierSummaries) {
      if ('ResourceType' in summary && summary.ResourceType && 'ResourceIdentifiers' in summary && summary.ResourceIdentifiers) {
        ret[summary.ResourceType] = (summary.ResourceIdentifiers ?? [])?.map(x => x.split(','));
      }
    }
    return ret;
  }

  /**
   * Ask for the importable identifier for the given resource
   *
   * There may be more than one identifier under which a resource can be imported. The `import`
   * operation needs exactly one of them.
   *
   * - If we can get one from the template, we will use one.
   * - Otherwise, we will ask the user for one of them.
   */
  private async askForResourceIdentifier(
    resourceIdentifiers: ResourceIdentifiers,
    chg: ImportableResource,
  ): Promise<ResourceIdentifierProperties | undefined> {
    const resourceName = this.describeResource(chg.logicalId);

    // Skip resources that do not support importing
    const resourceType = chg.resourceDiff.newResourceType;
    if (resourceType === undefined || !(resourceType in resourceIdentifiers)) {
      await this.ioHelper.defaults.warn(`${resourceName}: unsupported resource type ${resourceType}, skipping import.`);
      return undefined;
    }

    const idPropSets = resourceIdentifiers[resourceType];

    // Retain only literal strings: strip potential CFN intrinsics
    const resourceProps = Object.fromEntries(Object.entries(chg.resourceDefinition.Properties ?? {})
      .filter(([_, v]) => typeof v === 'string')) as Record<string, string>;

    // Find property sets that are fully satisfied in the template, ask the user to confirm them
    const satisfiedPropSets = idPropSets.filter(ps => ps.every(p => resourceProps[p]));
    for (const satisfiedPropSet of satisfiedPropSets) {
      const candidateProps = Object.fromEntries(satisfiedPropSet.map(p => [p, resourceProps[p]]));
      const displayCandidateProps = fmtdict(candidateProps);

      const importTheResource = await this.ioHelper.requestResponse(IO.CDK_TOOLKIT_I3100.req(`${chalk.blue(resourceName)} (${resourceType}): import with ${chalk.yellow(displayCandidateProps)}`, {
        resource: {
          type: resourceType,
          props: candidateProps,
          stringifiedProps: displayCandidateProps,
        },
      }));
      if (importTheResource) {
        return candidateProps;
      }
    }

    // If we got here and the user rejected any available identifiers, then apparently they don't want the resource at all
    if (satisfiedPropSets.length > 0) {
      await this.ioHelper.defaults.info(chalk.grey(`Skipping import of ${resourceName}`));
      return undefined;
    }

    // We cannot auto-import this, ask the user for one of the props
    // The only difference between these cases is what we print: for multiple properties, we print a preamble
    const prefix = `${chalk.blue(resourceName)} (${resourceType})`;
    const promptPattern = `${prefix}: enter %s`;
    if (idPropSets.length > 1) {
      const preamble = `${prefix}: enter one of ${idPropSets.map(x => chalk.blue(x.join('+'))).join(', ')} to import (leave all empty to skip)`;
      await this.ioHelper.defaults.info(preamble);
    }

    // Do the input loop here
    for (const idProps of idPropSets) {
      const input: Record<string, string> = {};
      for (const idProp of idProps) {
        // If we have a value from the template, use it as default. This will only be a partial
        // identifier if present, otherwise we would have done the import already above.
        const defaultValue = resourceProps[idProp] ?? '';

        const response = await this.ioHelper.requestResponse(IO.CDK_TOOLKIT_I3110.req(
          format(promptPattern, chalk.blue(idProp)),
          {
            resource: {
              name: resourceName,
              type: resourceType,
              idProp,
            },
            responseDescription: defaultValue ? undefined : 'empty to skip',
          },
          defaultValue,
        ));

        if (!response) {
          break;
        }

        input[idProp] = response;
        // Also stick this property into 'resourceProps', so that it may be reused by a subsequent question
        // (for a different compound identifier that involves the same property). Just a small UX enhancement.
        resourceProps[idProp] = response;
      }

      // If the user gave inputs for all values, we are complete
      if (Object.keys(input).length === idProps.length) {
        return input;
      }
    }

    await this.ioHelper.defaults.info(chalk.grey(`Skipping import of ${resourceName}`));
    return undefined;
  }

  /**
   * Convert the internal "resource mapping" structure to CloudFormation accepted "ResourcesToImport" structure
   */
  private async makeResourcesToImport(resourceMap: ImportMap): Promise<ResourcesToImport> {
    return resourceMap.importResources.map(res => ({
      LogicalResourceId: res.logicalId,
      ResourceType: res.resourceDiff.newResourceType!,
      ResourceIdentifier: resourceMap.resourceMap[res.logicalId],
    }));
  }

  /**
   * Convert CloudFormation logical resource ID to CDK construct tree path
   *
   * @param logicalId - CloudFormation logical ID of the resource (the key in the template's Resources section)
   * @returns Forward-slash separated path of the resource in CDK construct tree, e.g. MyStack/MyBucket/Resource
   */
  private describeResource(logicalId: string): string {
    return this.stack.template?.Resources?.[logicalId]?.Metadata?.['aws:cdk:path'] ?? logicalId;
  }

  /**
   * Removes CDKMetadata and Outputs in the template so that only resources for importing are left.
   * @returns template with import resources only
   */
  private removeNonImportResources() {
    return removeNonImportResources(this.stack);
  }
}

/**
 * Information about a resource in the template that is importable
 */
export interface ImportableResource {
  /**
   * The logical ID of the resource
   */
  readonly logicalId: string;

  /**
   * The resource definition in the new template
   */
  readonly resourceDefinition: any;

  /**
   * The diff as reported by `cloudformation-diff`.
   */
  readonly resourceDiff: ResourceDifference;
}

/**
 * The information necessary to execute an import operation
 */
export interface ImportMap {
  /**
   * Mapping logical IDs to physical names
   */
  readonly resourceMap: ResourceMap;

  /**
   * The selection of resources we are actually importing
   *
   * For each of the resources in this list, there is a corresponding entry in
   * the `resourceMap` map.
   */
  readonly importResources: ImportableResource[];
}

function fmtdict<A>(xs: Record<string, A>) {
  return Object.entries(xs).map(([k, v]) => `${k}=${v}`).join(', ');
}

/**
 * Add a default `DeletionPolicy` policy.
 * The default value is set to 'Retain', to lower risk of unintentionally
 * deleting stateful resources in the process of importing to CDK.
 */
function addDefaultDeletionPolicy(resource: any): any {
  if (resource.DeletionPolicy) {
    return resource;
  }

  return {
    ...resource,
    DeletionPolicy: 'Retain',
  };
}

export interface DiscoverImportableResourcesResult {
  readonly additions: ImportableResource[];
  readonly hasNonAdditions: boolean;
}

export function removeNonImportResources(stack:cxapi.CloudFormationStackArtifact) {
  const template = stack.template;
  delete template.Resources.CDKMetadata;
  delete template.Outputs;
  return template;
}
