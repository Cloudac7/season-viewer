import { computeSpatialField } from './spatial-field';
import type { SpatialFieldWorkerRequest, SpatialFieldWorkerResponse } from './spatial-field';

// Keep DOM canvas work on the caller; this worker only returns compact fields.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<SpatialFieldWorkerRequest>) => void) | null;
  postMessage: (message: SpatialFieldWorkerResponse, transfer?: Transferable[]) => void;
};

worker.onmessage = ({ data }) => {
  try {
    const result = computeSpatialField(data.input);
    worker.postMessage({ id: data.id, result }, [result.seasons.buffer, result.targets.buffer, result.temperature.buffer,
      result.average.buffer, result.status.buffer, result.expectedDays.buffer, result.transitionDays.buffer, result.estimated.buffer]);
  } catch (error) {
    worker.postMessage({ id: data.id, error: error instanceof Error ? error.message : '格点场计算失败' });
  }
};
