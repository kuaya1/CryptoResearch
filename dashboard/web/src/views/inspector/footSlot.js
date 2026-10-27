// The inspector's sticky footer as a place a part of its body can draw into
// (Eric, 2026-10-26): the PM Decision Card puts its decision buttons there,
// the same buttons with the same handlers and the same `seen` guard. Outside
// the inspector (no slot) they stay in the card. The value is { el, extras,
// claim }: the footer's element, the inspector's own actions that join the
// card's More menu while a ticket waits, and claim(true) while they do (L5).
import { createContext } from 'react';

export const FootSlot = createContext(null);
