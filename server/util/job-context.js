// Which job is this code running inside? AsyncLocalStorage follows the async
// call chain across await/timers/mapLimit automatically, so anything logging
// inside a job's handler can be routed to that job's live-log ring buffer.
//
// Dependency-free on purpose: worker.js (job runner) and util/log.js (the
// structured logger) both import it — putting it anywhere else would create
// an import cycle between them.
import { AsyncLocalStorage } from "node:async_hooks";

/** @type {AsyncLocalStorage<string>} store = jobId string */
export const jobLogContext = new AsyncLocalStorage();
