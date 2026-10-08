// Starting the desk: the session and the workspace (desk.js boot), then the
// router, once. Try again on the start screen runs it again; nothing reloads
// by itself (review 2026-10-08, F2).
import { boot } from './desk.js';
import { startRouter } from './router.js';

let routed = false;
export async function start() {
  let ok = false;
  try {
    ok = await boot();
  } catch (err) {
    console.error(err);
    ok = false;
  }
  if (ok && !routed) {
    routed = true;
    startRouter();
  }
  return ok;
}
