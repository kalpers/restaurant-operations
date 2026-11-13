/**
 * Phase 23 (policy 4): the location a browser page was rendered for. Client requests send
 * it, and the server refuses a request whose page shows a different location from the one
 * the session is now working at (another tab switched). It never grants access.
 */
export const LOCATION_HEADER = "x-location-id";

export const LOCATION_CHANGED_MESSAGE =
  "You switched location in another tab. Reload this page to continue.";
