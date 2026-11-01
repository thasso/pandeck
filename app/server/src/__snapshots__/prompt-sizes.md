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
| assistant | pi | 6,208 | 10,697 | 16,905 |
| assistant | claude | 6,188 | 9,994 | 16,182 |
| personal-assistant | pi | 5,542 | 18,557 | 24,099 |
| personal-assistant | claude | 5,522 | 9,994 | 15,516 |
| workshop | pi | 13,145 | 20,475 | 33,620 |
| workshop | claude | 6,892 | 11,957 | 18,849 |
| workflow-coordinator | pi | 3,386 | 2,232 | 5,618 |
| workflow-coordinator | claude | 3,366 | 1,475 | 4,841 |
| developer | pi | 13,590 | 19,988 | 33,578 |
| developer | claude | 7,337 | 11,461 | 18,798 |

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
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,487 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 14 |
| `tools:eager:names` | tools | yes | 112 |
| `tools:eager:descriptions` | tools | yes | 2,075 |
| `tools:eager:schemas` | tools | yes | 8,510 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 156,562 |

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
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,487 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 14 |
| `tools:eager:names` | tools | yes | 174 |
| `tools:eager:descriptions` | tools | yes | 1,703 |
| `tools:eager:schemas` | tools | yes | 8,117 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 157,480 |

## personal-assistant — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:personal-assistant` | prompt | yes | 1,288 |
| `integration:tempo` | prompt | yes | 224 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,778 |
| `profile-suffix` | prompt | yes | 107 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 48 |
| `tools:eager:names` | tools | yes | 123 |
| `tools:eager:descriptions` | tools | yes | 5,197 |
| `tools:eager:schemas` | tools | yes | 9,654 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 166,385 |

## personal-assistant — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:personal-assistant` | prompt | yes | 1,288 |
| `integration:tempo` | prompt | yes | 224 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,778 |
| `profile-suffix` | prompt | yes | 107 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 48 |
| `tools:eager:names` | tools | yes | 174 |
| `tools:eager:descriptions` | tools | yes | 1,703 |
| `tools:eager:schemas` | tools | yes | 8,117 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 167,393 |

## workshop — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,567 |
| `harness-base:pi-docs` | prompt | no | 1,137 |
| `pi-tool-list:builtin` | prompt | yes | 283 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 609 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:workshop` | prompt | yes | 3,404 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 3,769 |
| `assembly-overhead` | prompt | yes | 35 |
| `tools:eager:names` | tools | yes | 214 |
| `tools:eager:descriptions` | tools | yes | 5,876 |
| `tools:eager:schemas` | tools | yes | 10,802 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 196,031 |

## workshop — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:workshop` | prompt | yes | 3,404 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 3,613 |
| `assembly-overhead` | prompt | yes | 10 |
| `tools:eager:names` | tools | yes | 310 |
| `tools:eager:descriptions` | tools | yes | 2,382 |
| `tools:eager:schemas` | tools | yes | 9,265 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 197,354 |

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
| `tools:deferred:universe` | tools | no | 2,896 |

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
| `tools:deferred:universe` | tools | no | 2,914 |

## developer — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,567 |
| `harness-base:pi-docs` | prompt | no | 1,137 |
| `pi-tool-list:builtin` | prompt | yes | 283 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 609 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:developer` | prompt | yes | 3,849 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 3,769 |
| `assembly-overhead` | prompt | yes | 35 |
| `tools:eager:names` | tools | yes | 187 |
| `tools:eager:descriptions` | tools | yes | 5,702 |
| `tools:eager:schemas` | tools | yes | 10,516 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 198,502 |

## developer — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:developer` | prompt | yes | 3,849 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 3,613 |
| `assembly-overhead` | prompt | yes | 10 |
| `tools:eager:names` | tools | yes | 274 |
| `tools:eager:descriptions` | tools | yes | 2,208 |
| `tools:eager:schemas` | tools | yes | 8,979 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 199,834 |
