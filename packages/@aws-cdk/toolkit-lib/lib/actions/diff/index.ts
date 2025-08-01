import type { StackSelector } from '../../api/cloud-assembly';

export interface CloudFormationDiffOptions {
  /**
   * Whether to run the diff against the template after the CloudFormation Transforms inside it have been executed
   * (as opposed to the original template, the default, which contains the unprocessed Transforms).
   *
   * @default false
   */
  readonly compareAgainstProcessedTemplate?: boolean;
}

export interface ChangeSetDiffOptions extends CloudFormationDiffOptions {
  /**
   * Enable falling back to template-based diff in case creating the changeset is not possible or results in an error.
   *
   * Should be used for stacks containing nested stacks or when change set permissions aren't available.
   *
   * @default true
   */
  readonly fallbackToTemplate?: boolean;

  /**
   * Additional parameters for CloudFormation when creating a diff change set
   *
   * @default - No parameters
   */
  readonly parameters?: { [name: string]: string | undefined };

  /**
   * Whether or not the change set imports resources that already exist
   *
   * @default false
   */
  readonly importExistingResources?: boolean;
}

export interface LocalFileDiffOptions {
  /**
   * Path to the local file.
   */
  readonly path: string;
}

export class DiffMethod {
  /**
   * Use a changeset to compute the diff.
   *
   * This will create, analyze, and subsequently delete a changeset against the CloudFormation stack.
   */
  public static ChangeSet(options: ChangeSetDiffOptions = {}): DiffMethod {
    return new class extends DiffMethod {
      public override readonly options: ChangeSetDiffOptions;
      public constructor(opts: ChangeSetDiffOptions) {
        super('change-set', opts);
        this.options = opts;
      }
    }(options);
  }

  public static TemplateOnly(options: CloudFormationDiffOptions = {}): DiffMethod {
    return new class extends DiffMethod {
      public override readonly options: CloudFormationDiffOptions;
      public constructor(opts: CloudFormationDiffOptions) {
        super('template-only', opts);
        this.options = opts;
      }
    }(options);
  }

  /**
   * Use a local template file to compute the diff.
   */
  public static LocalFile(path: string): DiffMethod {
    return new class extends DiffMethod {
      public override readonly options: { path: string };
      public constructor(opts: LocalFileDiffOptions) {
        super('local-file', opts);
        this.options = opts;
      }
    }({ path });
  }

  private constructor(
    public readonly method: 'change-set' | 'template-only' | 'local-file',
    public readonly options: ChangeSetDiffOptions | CloudFormationDiffOptions | LocalFileDiffOptions,
  ) {
  }
}

/**
 * Options for the diff method
 */
export interface DiffOptions {
  /**
   * Select the stacks
   *
   * @default - All stacks
   */
  readonly stacks?: StackSelector;

  /**
   * The method to create a stack diff.
   *
   * Use changeset diff for the highest fidelity, including analyze resource replacements.
   * In this method, diff will use the deploy role instead of the lookup role.
   *
   * Use template-only diff for a faster, less accurate diff that doesn't require
   * permissions to create a change-set.
   *
   * Use local-template diff for a fast, local-only diff that doesn't require
   * any permissions or internet access.
   *
   * @default DiffMethod.ChangeSet
   */
  readonly method?: DiffMethod;

  /**
   * Strict diff mode
   * When enabled, this will not filter out AWS::CDK::Metadata resources, mangled non-ASCII characters, or the CheckBootstrapVersionRule.
   *
   * @default false
   */
  readonly strict?: boolean;

  /**
   * How many lines of context to show in the diff
   *
   * @default 3
   */
  readonly contextLines?: number;

  /**
   * Whether to include resource moves in the diff. These are the same moves that are detected
   * by the `refactor` command.
   *
   * @default false
   */
  readonly includeMoves?: boolean;
}
