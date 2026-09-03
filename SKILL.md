---
name: cf-worker-github-sync
description: Pure-frontend apps sync JSON to GitHub via Cloudflare Worker so browsers never hold a PAT. Use when adding cloud sync, multi-device login, or per-user data without exposing GitHub tokens — triggers include Cloudflare Worker sync, GitHub Contents proxy, 免 Token 同步, 跨设备同步.
---

# Cloudflare Worker + GitHub 云同步

浏览器不持有 GitHub PAT。PAT 只存在 Worker 环境变量里；前端只请求 Worker。

## 架构

```
前端 (index.html)  --POST JSON-->  Cloudflare Worker  --Bearer PAT-->  GitHub Contents API
                                      env secrets only
```

| 数据 | 仓库路径 | 说明 |
|------|----------|------|
| 账号表 | `data/_accounts.json` | 昵称 → `{salt,hash,createdAt}` |
| 用户数据 | `data/{nick}.json` | 按昵称隔离的业务 JSON |

## 何时用本 Skill

- 纯静态页 / GitHub Pages / `file://` 需要云端读写
- 多设备同一账号同步，且不能让用户填 PAT
- 按用户/昵称分文件存储

不要用：需要实时协作冲突合并、强鉴权会话（应上完整后端或 Supabase）。

## 实施步骤（按顺序）

### 1. 准备 GitHub

1. 创建仓库（可私有）
2. Classic PAT，勾选 `repo`（或 fine-grained 的 contents 读写）
3. 不要把 PAT 写进前端仓库

### 2. 部署 Worker

1. Cloudflare Dashboard → Workers & Pages → Create → **Start with Hello World!**
2. 名称示例 `app-sync` → Deploy
3. Edit code：用 [assets/worker.js](assets/worker.js) 全量替换 → Save and deploy
4. Settings → **Runtime variables and secrets** 添加：

| Name | Type | Value |
|------|------|--------|
| `GITHUB_TOKEN` | Secret | `ghp_...` |
| `GITHUB_OWNER` | Plaintext | 用户名 |
| `GITHUB_REPO` | Plaintext | 仓库名 |
| `GITHUB_BRANCH` | Plaintext（可选） | 默认 `main` |
| `SYNC_SECRET` | Secret（可选） | 有则请求头需 `X-Sync-Secret` |

5. 再 Deploy 一次
6. 自测：`https://{name}.{subdomain}.workers.dev/?action=pull&nick=test`  
   期望：`{"ok":true,"exists":false,"data":null}`（文件尚不存在时）

变量不生效时：确认挂在该 Worker 的 Production、名称全大写、改完已 Deploy。临时可硬编码验证，通过后改回 `env`。

### 3. 接入前端

1. 复制 [assets/sync-client.js](assets/sync-client.js) 或内联其 API
2. 配置 Worker 根地址（无尾斜杠），可选 `SYNC_SECRET`
3. 业务侧约定：
   - 登录标识 `nick`（2–16 字符，去掉路径非法字符）
   - 拉取：`workerPost({ action:"pull", nick })` → `data.checklist` 等
   - 推送：`workerPost({ action:"push", nick, checklist, lastCity })`
   - 账号：`accounts_pull` / `accounts_push`
4. 变更后防抖推送（约 800ms）；进入应用时先 pull

接口约定见 [references/api.md](references/api.md)。

### 4. 密码与跨设备

- 密码：`SHA-256(password + salt)`，只存哈希；注册后 `accounts_push` 合并写入云端
- 新设备：配置同一 Worker 地址 → 登录时 `accounts_pull` 校验 → `pull` 业务数据
- 前端永不出现 GitHub PAT 输入框

## 安全要点

- PAT 仅 Worker Secret；前端最多存 Worker URL + 可选 SYNC_SECRET
- `Access-Control-Allow-Origin: *` 便于静态页；生产可收紧 Origin，并启用 `SYNC_SECRET`
- 本方案是个人/小范围同步，不是多租户强隔离后端

## Agent 执行清单

用户要求「用 Worker 同步到 GitHub / 免 Token 云同步」时：

1. 给出或复用 `assets/worker.js`，说明变量表与自测 URL
2. 在页面中接入 `workerPost`（或 `sync-client.js`），去掉直连 `api.github.com` 的用户 Token 逻辑
3. 按昵称隔离路径 `data/{nick}.json`；账号表 `_accounts.json`
4. 勾选/保存类操作接防抖 push；启动/登录接 pull
5. 提醒用户配置 Secret 并 Deploy，勿提交 PAT 到 git
