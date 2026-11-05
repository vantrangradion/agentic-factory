/**
 * Core Domain Contracts & Interfaces
 * Inviolable invariant: Zero runtime dependencies.
 */

export interface EntityMetadata {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProcessingStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface BaseEvent<T = unknown> {
  readonly eventId: string;
  readonly timestamp: number;
  readonly type: string;
  readonly payload: T;
}
