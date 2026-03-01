Generate conventional commit proposal for the current working copy changes in this jujutsu repository.

{{#if user_context}}
User context:
{{user_context}}
{{/if}}

{{#if changelog_targets}}
Changelog targets (must call propose_changelog for these files):
{{changelog_targets}}
{{/if}}

Use jj_* tools to inspect changes. Finish with propose_commit or split_commit.
