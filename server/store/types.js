// JSDoc-only type definitions for the store layer (no runtime exports beyond
// this comment block's typedefs). Rows keep their full object as JSON in a
// `data` column, so these describe the DESERIALIZED shapes handlers work with —
// extra ad-hoc fields always survive round-trips (that's the design).
//
// Import in JSDoc position only:
//   /** @returns {import("./types.js").Politician[]} */

/**
 * @typedef {object} Politician
 * @property {string} id
 * @property {string} name
 * @property {string} [office]    e.g. "MP (Lok Sabha)", "MLA"
 * @property {string} [state]
 * @property {string} [constituency]
 * @property {string} [party]
 * @property {boolean} [is_demo]
 * @property {string} [created_at] ISO timestamp
 */

/**
 * @typedef {object} Evidence
 * @property {string} id
 * @property {string} politician_id
 * @property {string} [source_type]  fetcher id, e.g. "myneta", "sansad", "news"
 * @property {number} [tier]         1 (primary record) … 9 (headline lead)
 * @property {boolean} [admissible]  may a public card cite it?
 * @property {string} [title]
 * @property {string} [url]
 * @property {string|null} [date]    ISO date of the underlying document
 * @property {string} [summary]
 * @property {string} [content]      extracted body text
 * @property {string} [fetched_at]   ISO timestamp
 */

/**
 * @typedef {object} Report
 * @property {string} id
 * @property {string} politician_id
 * @property {string} [report_tier]  "full" | "incremental" | "recheck"
 * @property {string} [generated_at] ISO timestamp
 * @property {string} [grade]
 * @property {number} [score]
 */

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {"politician"|"ministry"|"party"} kind
 * @property {string} subject_key   politician id / ministry key / party key
 * @property {string} [generated_at]
 * @property {string} [grade]
 * @property {number} [score]
 * @property {string} [headline]
 */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} type
 * @property {"queued"|"running"|"done"|"dead"|"cancelled"} status
 * @property {number} [priority]
 * @property {number} [run_at]      epoch ms; claimable once due
 * @property {number} [attempts]
 * @property {number} [max_attempts]
 * @property {object} [payload]
 * @property {string} [last_error]
 * @property {string} [created_at]
 */

/**
 * @typedef {object} Lead
 * @property {string} id
 * @property {string} [key]         dedupe key (detector + subject)
 * @property {"detected"|"proposed"|"published"|"cleared"|"dismissed"} status
 * @property {string} [actor_id]
 * @property {number} [signal_score]
 */

export {};
