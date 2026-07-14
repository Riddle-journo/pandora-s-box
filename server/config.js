// Central config helper — one place to read env vars that have accumulated
// multiple historical aliases across the codebase.
export function dataGovKey() {
  return process.env.DATA_GOV_IN_KEY || process.env.DATA_GOV_API_KEY || process.env.DATA_GOV_KEY || process.env.OGD_API_KEY || "";
}
