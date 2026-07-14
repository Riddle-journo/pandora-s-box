// Frontend entry point (Task 9.1). Import order: core's theme IIFE runs first
// (no flash of wrong theme), then the legacy monolith wires everything.
import "./core.js";
import "./legacy.js";
