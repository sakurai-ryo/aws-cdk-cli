import type * as cxapi from '@aws-cdk/cx-api';
import type { StackEvent } from '@aws-sdk/client-cloudformation';
import type { StackProgress } from './progress';
import type { ResourceMetadata } from '../api/resource-metadata/resource-metadata';

/**
 * Payload when stack monitoring is starting or stopping for a given stack deployment.
 */
export interface StackMonitoringControlEvent {
  /**
   * A unique identifier for a specific stack deployment.
   *
   * Use this value to attribute stack activities received for concurrent deployments.
   */
  readonly deployment: string;

  /**
   * The stack artifact that is getting deployed
   */
  readonly stack: cxapi.CloudFormationStackArtifact;

  /**
   * The name of the Stack that is getting deployed
   */
  readonly stackName: string;

  /**
   * Total number of resources taking part in this deployment
   *
   * The number might not always be known or accurate.
   * Only use for informational purposes and handle the case when it's unavailable.
   */
  readonly resourcesTotal?: number;
}

export interface StackActivity {
  /**
   * A unique identifier for a specific stack deployment.
   *
   * Use this value to attribute stack activities received for concurrent deployments.
   */
  readonly deployment: string;

  /**
   * The Stack Event as received from CloudFormation
   */
  readonly event: StackEvent;

  /**
   * Additional resource metadata
   *
   * This information is only available if the information is available in the current cloud assembly.
   * I.e. no `metadata` will not be available for resource deletion events.
   */
  readonly metadata?: ResourceMetadata;

  /**
   * The stack progress
   */
  readonly progress: StackProgress;
}
