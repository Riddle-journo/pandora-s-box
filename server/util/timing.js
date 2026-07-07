// Tiny stopwatch for long-running CLI tasks (task #12). Call at the start;
// invoke the returned function at the end to print a human-readable elapsed.
export function startTimer(label) {
  const t0 = Date.now();
  return () => {
    const ms = Date.now() - t0;
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000) % 60;
    const h = Math.floor(ms / 3600000);
    const human = h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${(ms / 1000).toFixed(1)}s`;
    console.log(`\n⏱  ${label} finished in ${human} (${new Date().toLocaleTimeString()}).`);
    return ms;
  };
}
