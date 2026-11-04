/**
 * `_meta.mint` hints (the mcp-host context-groups contract): which canonical
 * group a tool belongs to, what kind of ask it answers, and the everyday words
 * its name and description lack. Inert data to any other client.
 *
 * Group `home`. The one question this server genuinely answers is
 * "what's new" — the base station's event log (`simplisafe_get_events`), the
 * canonical read. Nothing here is due or scheduled, so there is no whats-due
 * or whats-on read.
 *
 * No `subject`: the systems ARE listable, but `sid` is optional on the
 * common one-system account, and the only labels a system carries are its
 * location fields — usually an empty `locationName`, so in practice the street
 * address or city — which would put the person's address into every tool
 * listing. Listing them at start would also spend a refresh-token exchange on
 * every boot, before anything was asked. A multi-system account names `sid`.
 * No `when`: the log takes a start (`from_timestamp`, Unix seconds), never a
 * range.
 */
const DOMAIN = 'home';

/** A read: state, settings, devices. */
export const LOOKUP_META = { mint: { domain: DOMAIN, intent: 'lookup' } };

/** The canonical "anything new at home?" read. */
export const EVENTS_META = {
  mint: {
    domain: DOMAIN,
    intent: 'whats-new',
    canonical: true,
    aliases: ['alarm', 'security', 'security system', 'activity', 'doors', 'sensors', 'simplisafe'],
  },
};

/** Arm / disarm. */
export const ALARM_META = {
  mint: {
    domain: DOMAIN,
    intent: 'turn-on-off',
    aliases: ['alarm', 'arm', 'disarm', 'security system', 'away mode', 'home mode'],
  },
};

/** Lock / unlock. */
export const LOCK_META = {
  mint: { domain: DOMAIN, intent: 'turn-on-off', aliases: ['lock', 'unlock', 'door lock', 'deadbolt', 'smart lock'] },
};
