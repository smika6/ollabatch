// Whether each card lends right now, by the machine owner's rules.
//   when-free  lend unless a fullscreen program has used the card for 10 s;
//              come back 3 minutes after it stops
//   always     lend regardless          never     don't lend
//   schedule   lend only inside the time windows (local time; a window whose
//              end is before its start runs past midnight, and `days` are the
//              days it starts on, 0 = Sunday)
// The owner's Pause on the local page wins over all of them.

const ENTER_MS = 10_000;
const LEAVE_MS = 3 * 60_000;
const minutes = (hhmm) => { const [h, m] = String(hhmm ?? '').split(':').map(Number); return h * 60 + m; };

export function inSchedule(schedule, t) {
  const d = new Date(t);
  const now = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay(), yesterday = (today + 6) % 7;
  // A malformed window (from an older config, say) simply never matches.
  return (Array.isArray(schedule) ? schedule : []).some((w) => {
    const { days, from, to } = w || {};
    const a = minutes(from), b = minutes(to);
    if (!Array.isArray(days) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a < b) return days.includes(today) && now >= a && now < b;
    return (days.includes(today) && now >= a) || (days.includes(yesterday) && now < b);
  });
}

export class LendPolicy {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.seen = {};   // cardId → { since, last }
  }

  // stepAside: a fullscreen program pauses a card under any policy (used when
  // the pool, not the owner, set the policy).
  evaluate({ policy, schedule = [], inUse, ownerPaused, cards, stepAside = false }) {
    const now = this.now();
    const out = {};
    for (const id of cards) {
      const s = (this.seen[id] ??= { since: null, last: null, paused: false });
      if (inUse.has(id)) { s.since ??= now; s.last = now; } else { s.since = null; }
      if (!s.paused && s.since != null && now - s.since >= ENTER_MS) s.paused = true;
      if (s.paused && !inUse.has(id) && now - s.last >= LEAVE_MS) s.paused = false;

      let reason = null;
      if (policy === 'never') reason = 'never';
      else if (ownerPaused.has(id)) reason = 'paused-by-owner';
      else if (policy === 'schedule' && !inSchedule(schedule, now)) reason = 'outside-schedule';
      else if ((policy === 'when-free' || stepAside) && s.paused) reason = 'paused-in-use';
      out[id] = { lend: reason == null, reason };
    }
    return out;
  }
}
