# thegram-memory

OMP(oh-my-pi) 코딩 에이전트가 Thegram을 단일 영구 메모리로 쓰게 하는 확장과 정책이다. 정본 볼트는 `~/gram`이다.

## 구성

| 파일 | 역할 |
|---|---|
| `thegram-memory.ts` | OMP 확장. 읽기 경로를 맡는다. |
| `AGENTS.memory.md` | `~/.omp/agent/AGENTS.md`에 넣는 `## Memory (Thegram)` 절의 원문. 쓰기 규칙을 정한다. |
| `tsconfig.json` | 로컬 oh-my-pi 체크아웃의 타입으로 확장을 검사한다. |

## 동작

- 읽기는 확장이 한다. 확장은 Thegram 앱의 unix socket(`~/Library/Application Support/Thegram/mcp.json`의 `socket`)을 직접 호출한다.
  - 세션의 첫 프롬프트와 압축 직후에는 `gram_brief`와 첫 프롬프트의 `gram_recall` 결과를 `<thegram-memory>` 메시지로 넣는다.
  - 이후 프롬프트에는 `gram_changes`로 다른 작성자의 변경만 넣는다. 이 세션이 쓴 revision은 뺀다.
  - semantic recall은 관련도 하한이 없어 항상 top_k건을 돌려준다. 그래서 recall은 brief를 넣을 때만 한다.
- 쓰기는 메인 에이전트가 `thegram` MCP의 `gram_patch`로 한다. 기록 판단, CAS와 `request_id` 영수증을 한 주체가 맡는다.
- 한 요청에서 파일 편집이 3회 이상이거나 git commit이 있고 Thegram 쓰기가 없으면, 최종 답 전에 리마인더를 한 번 넣는다. 리마인더는 `context` 이벤트로 넣는다. `session_stop` 이어가기 턴은 omp-control이 고르는 최종 답을 바꾸기 때문이다.
- 서브에이전트 세션에는 아무것도 넣지 않는다.
- 앱이 꺼져 있거나 socket이 없으면 `E_APP_NOT_RUNNING` 안내 한 줄만 넣고 세션은 계속한다.
- `/thegram` 명령은 현재 프로젝트의 문서, 열린 항목 수와 `next`를 알린다.

## 프로젝트 매핑

git 저장소는 common dir 기준 저장소 이름과 같은 볼트 폴더에 연결된다. worktree는 원래 저장소의 폴더를 공유한다. 예외는 `~/.omp/agent/thegram-projects.json`에 디렉터리 접두사로 적는다. 가장 긴 접두사가 이긴다.

```json
{
	"/Users/steve/.omp": "omp",
	"/Users/steve/thegram/thegram-memory": "omp"
}
```

git 저장소도 아니고 매핑도 없는 디렉터리에서는 확장이 아무것도 하지 않는다.

## 설치

1. Thegram 앱을 실행하고 에이전트 접근을 쓰기로 둔다.
2. 확장을 연결한다.
   ```sh
   ln -s ~/thegram/thegram-memory/thegram-memory.ts ~/.omp/agent/extensions/thegram-memory.ts
   ```
3. `AGENTS.memory.md`의 절을 `~/.omp/agent/AGENTS.md`에 넣는다. 이 파일을 바꾸면 설치본도 같이 바꾼다.
4. `~/.omp/agent/config.yml`에서 다른 메모리 백엔드를 끈다: `memory.backend: "off"`.
5. 같은 `gram_*` 도구 이름을 노출하는 다른 MCP 서버가 있으면 `~/.omp/agent/mcp.json`의 `disabledServers`에 넣는다.
6. 새 OMP 세션을 연다. 확장과 설정은 세션 시작 때 읽힌다.

## 검사

```sh
/Users/steve/clab-one/oh-my-pi/node_modules/.bin/tsgo -p tsconfig.json --noEmit
```

실제 동작은 git 저장소에서 `omp -p`를 실행해 확인한다. 세션 기록(jsonl)에 `customType: "thegram-memory"` 메시지가 있어야 한다.

## 제한

- `gram_profile {task: "memory"}`에는 add 연산 형식이 없다. 그래서 `AGENTS.memory.md`와 리마인더에 검증된 형식을 적었다.
- Thegram은 정해진 필드 키 외에는 `E_FIELD`로 거부한다. DOT 업무 원장 필드(`next_action`, `next_check_at`, `waiting_on`)를 담을 수 없어 원장은 아직 GBrain에 있다.

근거: thegram-memory.ts 소스, tsgo 타입 검사, 2026-10-10 omp -p·RPC 스모크 세션 · 2026-10-10 12:33 KST
