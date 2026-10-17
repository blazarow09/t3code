# Optional Everything filename search on Windows

Large local workspaces can use an existing [Everything](https://www.voidtools.com/)
index for filename lookup instead of starting T3's own filename scanner.
This option is experimental and disabled by default.

Install and run Everything on the machine hosting the T3 server. Download the
official [ES CLI](https://www.voidtools.com/downloads/) version 1.1.0.38 or later
to a permanent folder. Everything 1.4 is supported; its search application must
be running, not only its indexing service. Git must also be available to T3.

Set `T3CODE_EVERYTHING_ES` to the absolute path of `es.exe` **before starting a
T3 server built with this feature**. For example, in PowerShell:

```powershell
$env:T3CODE_EVERYTHING_ES = 'C:\Tools\Everything\es.exe'
t3
```

For desktop T3, set the variable in the shell that launches the desktop
executable. An already-running desktop instance will keep its original
environment. Close it normally when your work allows, then launch it from that
shell. Remote web and mobile clients use the search backend of their connected
server, not an Everything instance on the client.

Remove the variable and restart T3 to return entirely to native search. No
Everything settings, index contents, or system search settings are changed.

## Behavior and limits

- Composer filename lookup, file pickers, and the legacy whole-workspace list
  can use Everything. Expanding an individual directory still reads that
  directory directly. Content searches use T3's native search engine.
- Searches stay inside the selected local drive folder, respect Git ignore
  rules (including nested repositories) and hierarchical `.ignore` rules, and
  retain non-repository cache exclusions. Directory junctions and symlinks are
  excluded from this optional backend. Network shares and drive-root workspaces
  use native search.
- Matching supports fuzzy subsequences, with exact basename matches ranked
  first. It does not reproduce the native engine's typo correction, query
  history, or frecency ranking.
- Everything's configured exclusions and indexing coverage determine which
  names are available. Its index updates asynchronously; freshly created or
  renamed files can take a moment to appear. Directory browsing reads current
  filesystem state immediately.
- Picker queries inspect at most 2,001 candidates; legacy whole-workspace lists
  at most 25,001. Results report truncation when limited. Narrow broad queries
  when needed; ranking applies within the returned candidate pool.
- Missing Everything/ES, an unindexed root, unreadable ignore rules, or a failed
  query falls back to native search. Failed attempts back off for 30 seconds.
  A fallback native index stays in use until its normal idle expiry, avoiding
  two active filename backends for the same workspace.
- Agent terminal commands and provider-owned search tools are unchanged. This
  setting does not replace their `rg`, Git, or shell commands.

Independently of this option, overlapping native filename refreshes are
coalesced. Content indexes are invalidated after workspace changes and rebuilt
only on the next content search. That next search may pay the warmup cost;
completed turns no longer trigger an unused content-index rebuild.
