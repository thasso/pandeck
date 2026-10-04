# Assembled prompt sizes

Generated — never edit by hand. Rewrite it and review the delta with:

    pnpm --filter @assistant/server test -u src/promptBudgets.test.ts

All numbers are characters, measured against this checkout's
`config/prompts` at the normalized working directory `/repo`
and with every conditional prompt section ON — the worst case over
conditions, at a normalized path. pi's own install directory is
normalized to `/pi` for the same reason, so a CI container
and a developer checkout measure the same commit alike. The enforced
ceilings live in `config/prompt-budgets.json`; this file records the
sizes only.

| Persona | Harness | System prompt | Eager tools | First request |
| --- | --- | ---: | ---: | ---: |
| assistant | pi | 6,235 | 10,667 | 16,902 |
| assistant | claude | 6,215 | 9,964 | 16,179 |
| personal-assistant | pi | 5,465 | 10,667 | 16,132 |
| personal-assistant | claude | 5,445 | 9,964 | 15,409 |
| workshop | pi | 13,052 | 20,445 | 33,497 |
| workshop | claude | 6,919 | 11,927 | 18,846 |
| workflow-coordinator | pi | 3,386 | 2,232 | 5,618 |
| workflow-coordinator | claude | 3,366 | 1,475 | 4,841 |
| developer | pi | 13,486 | 19,958 | 33,444 |
| developer | claude | 7,353 | 11,431 | 18,784 |

## assistant — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:assistant` | prompt | yes | 1,137 |
| `integration:slack` | prompt | yes | 1,146 |
| `integration:google` | prompt | yes | 327 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,487 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 14 |
| `tools:eager:names` | tools | yes | 112 |
| `tools:eager:descriptions` | tools | yes | 2,104 |
| `tools:eager:schemas` | tools | yes | 8,451 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 139,953 |

## assistant — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:assistant` | prompt | yes | 1,137 |
| `integration:slack` | prompt | yes | 1,146 |
| `integration:google` | prompt | yes | 327 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,487 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 14 |
| `tools:eager:names` | tools | yes | 174 |
| `tools:eager:descriptions` | tools | yes | 1,732 |
| `tools:eager:schemas` | tools | yes | 8,058 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 140,835 |

## personal-assistant — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:personal-assistant` | prompt | yes | 1,184 |
| `integration:tempo` | prompt | yes | 224 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,778 |
| `profile-suffix` | prompt | yes | 107 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 48 |
| `tools:eager:names` | tools | yes | 112 |
| `tools:eager:descriptions` | tools | yes | 2,104 |
| `tools:eager:schemas` | tools | yes | 8,451 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 142,152 |

## personal-assistant — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:personal-assistant` | prompt | yes | 1,184 |
| `integration:tempo` | prompt | yes | 224 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,778 |
| `profile-suffix` | prompt | yes | 107 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 48 |
| `tools:eager:names` | tools | yes | 174 |
| `tools:eager:descriptions` | tools | yes | 1,732 |
| `tools:eager:schemas` | tools | yes | 8,058 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 143,052 |

## workshop — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,447 |
| `harness-base:pi-docs` | prompt | no | 1,017 |
| `pi-tool-list:builtin` | prompt | yes | 283 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 609 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:workshop` | prompt | yes | 3,404 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 3,769 |
| `assembly-overhead` | prompt | yes | 35 |
| `tools:eager:names` | tools | yes | 214 |
| `tools:eager:descriptions` | tools | yes | 5,905 |
| `tools:eager:schemas` | tools | yes | 10,743 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 169,925 |

## workshop — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:workshop` | prompt | yes | 3,404 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 3,613 |
| `assembly-overhead` | prompt | yes | 10 |
| `tools:eager:names` | tools | yes | 310 |
| `tools:eager:descriptions` | tools | yes | 2,411 |
| `tools:eager:schemas` | tools | yes | 9,206 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 171,167 |

## workflow-coordinator — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:workflow-coordinator` | prompt | yes | 3,366 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 0 |
| `tools:eager:names` | tools | yes | 46 |
| `tools:eager:descriptions` | tools | yes | 1,155 |
| `tools:eager:schemas` | tools | yes | 1,031 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 2,937 |

## workflow-coordinator — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:workflow-coordinator` | prompt | yes | 3,366 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 0 |
| `tools:eager:names` | tools | yes | 54 |
| `tools:eager:descriptions` | tools | yes | 783 |
| `tools:eager:schemas` | tools | yes | 638 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 2,955 |

## developer — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,447 |
| `harness-base:pi-docs` | prompt | no | 1,017 |
| `pi-tool-list:builtin` | prompt | yes | 283 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 609 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:developer` | prompt | yes | 3,838 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 3,769 |
| `assembly-overhead` | prompt | yes | 35 |
| `tools:eager:names` | tools | yes | 187 |
| `tools:eager:descriptions` | tools | yes | 5,731 |
| `tools:eager:schemas` | tools | yes | 10,457 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 168,736 |

## developer — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:developer` | prompt | yes | 3,838 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 597 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 3,613 |
| `assembly-overhead` | prompt | yes | 10 |
| `tools:eager:names` | tools | yes | 274 |
| `tools:eager:descriptions` | tools | yes | 2,237 |
| `tools:eager:schemas` | tools | yes | 8,920 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 169,969 |
