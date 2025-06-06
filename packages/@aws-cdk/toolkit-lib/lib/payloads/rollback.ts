import type * as cxapi from '@aws-cdk/cx-api';

export interface StackRollbackProgress {
  /**
   * The total number of stacks being rolled back
   */
  readonly total: number;
  /**
   * The count of the stack currently attempted to be rolled back
   *
   * This is counting value, not an identifier.
   */
  readonly current: number;
  /**
   * The stack that's currently being rolled back
   */
  readonly stack: cxapi.CloudFormationStackArtifact;
}
