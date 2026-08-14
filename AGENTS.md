# Agent guidance

Follow `CONTRIBUTING.md` for product changes to this repository.

## Shared activity log

The activity log is optional and disabled by default. An agent must not enable
it, name its owner, or post to it without an explicit request from a human.

Before adding an update, confirm all three conditions:

1. `site/hub.config.js` has `activityLog.enabled: true`.
2. `activityLog.owner` names the human accountable for the log.
3. That human explicitly asked for the workstream update to be shared.

Use `node scripts/add-activity.mjs --help` and let the command write the entry.
Each entry is one concise outcome, milestone, decision, blocker, or next step,
plus an HTTPS link to the true project record. Review the diff before committing.

Never post private reasoning traces, messages, credentials, personal data, raw
customer data, raw logs, or secrets. The owner label is the minimum approved
attribution, not permission to include any other personal information. Humans
remain accountable for decisions and external actions; an activity entry never
records an agent as the decision-maker.
