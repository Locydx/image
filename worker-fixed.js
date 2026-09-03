// Cloudflare Worker — 修复中文乱码 + 按昵称隔离
// 部署后请在 Settings 确认 GITHUB_TOKEN / OWNER / REPO / BRANCH

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    const url = new URL(request.url);
    let action = url.searchParams.get('action');
    let body = {};

    if (request.method === 'POST') {
      try {
        body = await request.json();
        if (!action) action = body.action;
      } catch (e) {}
    }

    if (!action) {
      return json({ ok: false, error: '未知操作', debug: { method: request.method, url: request.url } });
    }

    if (env.SYNC_SECRET) {
      const secret = request.headers.get('X-Sync-Secret');
      if (secret !== env.SYNC_SECRET) {
        return json({ ok: false, error: 'invalid sync secret' }, 403);
      }
    }

    try {
      if (['pull', 'push', 'accounts_pull', 'accounts_push'].includes(action)) {
        return await handleJsonSync(env, action, body, url);
      }
      if (['list', 'upload', 'delete'].includes(action)) {
        return await handleFileProxy(env, action, body);
      }
      // AI 菜谱推荐（密钥仅存在 Worker 环境变量）
      if (action === 'ai_recommend') {
        return await handleAiRecommend(env, body);
      }
      return json({ ok: false, error: '未知操作: ' + action });
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 500);
    }
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Secret',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() }
  });
}

function getConfig(env, body) {
  return {
    owner:  (body.owner  || env.GITHUB_OWNER  || 'Locydx').trim(),
    repo:   (body.repo   || env.GITHUB_REPO   || 'image').trim(),
    branch: (body.branch || env.GITHUB_BRANCH || 'main').trim(),
    token:  env.GITHUB_TOKEN,
    path:   (body.path   || env.IMAGE_PATH    || 'images/').replace(/\/?$/, '/')
  };
}

// ===== UTF-8 安全的 base64（解决中文乱码）=====
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function handleJsonSync(env, action, body, url) {
  const nick = (body.nick || url.searchParams.get('nick') || '').trim();
  if (!nick || nick.length < 2 || nick.length > 16) {
    return json({ ok: false, error: 'nick required (2-16 chars)' }, 400);
  }
  const safeNick = nick.replace(/[\/\\:*?"<>|]/g, '_');
  const { owner, repo, branch, token } = getConfig(env, body);
  if (!token) return json({ ok: false, error: 'GITHUB_TOKEN not set' }, 500);

  if (action === 'accounts_pull') {
    const data = await githubGetJson(owner, repo, 'data/_accounts.json', branch, token);
    return json({ ok: true, exists: !!data, data: data || {} });
  }

  if (action === 'accounts_push') {
    const existing = await githubGetJson(owner, repo, 'data/_accounts.json', branch, token) || {};
    const merged = { ...existing, ...(body.accounts || {}) };
    await githubPutJson(owner, repo, 'data/_accounts.json', branch, token, merged, 'update accounts');
    return json({ ok: true });
  }

  if (action === 'pull') {
    // 每个昵称独立文件：data/{nick}.json
    const data = await githubGetJson(owner, repo, `data/${safeNick}.json`, branch, token);
    return json({ ok: true, exists: !!data, data: data || null });
  }

  if (action === 'push') {
    const payload = { ...body };
    delete payload.action;
    delete payload.nick;
    delete payload.owner;
    delete payload.repo;
    delete payload.branch;
    delete payload.path;
    // 确保写入 folders / categories / imgMeta
    await githubPutJson(owner, repo, `data/${safeNick}.json`, branch, token, payload, `sync ${safeNick}`);
    return json({ ok: true, path: `data/${safeNick}.json` });
  }
}

async function handleFileProxy(env, action, body) {
  const { owner, repo, branch, token, path: basePath } = getConfig(env, body);
  if (!token) return json({ ok: false, error: 'GITHUB_TOKEN not set' }, 500);

  if (action === 'list') {
    const files = await githubList(owner, repo, basePath, branch, token);
    const images = (files || [])
      .filter(f => f.type === 'file' && /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|heif)$/i.test(f.name))
      .map(f => ({
        id: 'gh-' + f.sha.slice(0, 8),
        name: f.name,
        url: f.download_url,
        sha: f.sha,
        source: 'GitHub'
      }));
    return json({ ok: true, images, path: basePath });
  }

  if (action === 'upload') {
    const { name, content, message } = body;
    if (!name || !content) return json({ ok: false, error: 'name + content required' }, 400);
    const result = await githubPutFile(owner, repo, basePath + name, branch, token, content, message || `upload ${name}`);
    return json({ ok: true, content: result.content });
  }

  if (action === 'delete') {
    const { name, sha, message } = body;
    if (!name || !sha) return json({ ok: false, error: 'name + sha required' }, 400);
    await githubDeleteFile(owner, repo, basePath + name, branch, token, sha, message || `delete ${name}`);
    return json({ ok: true });
  }
}

async function githubFetch(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'CF-Worker',
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function githubGetJson(owner, repo, path, branch, token) {
  try {
    const data = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      token
    );
    if (!data || !data.content) return null;
    // UTF-8 安全解码，避免中文乱码
    return JSON.parse(base64ToUtf8(data.content));
  } catch (e) {
    if (String(e.message).includes('404') || String(e.message).includes('Not Found')) return null;
    throw e;
  }
}

async function githubPutJson(owner, repo, path, branch, token, obj, message) {
  let sha = null;
  try {
    const existing = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      token
    );
    sha = existing.sha;
  } catch (_) {}
  // UTF-8 安全编码
  const content = utf8ToBase64(JSON.stringify(obj, null, 2));
  return githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) })
    }
  );
}

async function githubList(owner, repo, path, branch, token) {
  try {
    return await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      token
    );
  } catch (e) {
    if (String(e.message).includes('404') || String(e.message).includes('Not Found')) return [];
    throw e;
  }
}

async function githubPutFile(owner, repo, path, branch, token, base64content, message) {
  let sha = null;
  try {
    const existing = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      token
    );
    sha = existing.sha;
  } catch (_) {}
  return githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ message, content: base64content, branch, ...(sha ? { sha } : {}) })
    }
  );
}

async function githubDeleteFile(owner, repo, path, branch, token, sha, message) {
  return githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    token,
    {
      method: 'DELETE',
      body: JSON.stringify({ message, sha, branch })
    }
  );
}

// ========== AI 菜谱推荐（通义千问 / DashScope）==========
async function handleAiRecommend(env, body) {
  const apiKey = env.QWEN_API_KEY || env.AI_API_KEY || env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: '未配置 QWEN_API_KEY（请在 Worker Secrets 中添加）' }, 500);
  }

  const height = Number(body.height);
  const weight = Number(body.weight);
  const filterLabel = body.filterLabel || '均衡营养';
  const model = body.model || env.AI_MODEL || 'qwen-plus';

  if (!height || !weight || height < 100 || height > 250 || weight < 30 || weight > 300) {
    return json({ ok: false, error: '请填写有效的身高（100-250cm）和体重（30-300kg）' }, 400);
  }

  const bmi = weight / ((height / 100) ** 2);
  let label = '正常';
  if (bmi < 18.5) label = '偏瘦';
  else if (bmi < 24) label = '正常';
  else if (bmi < 28) label = '超重';
  else label = '肥胖';

  const prompt =
    `你是一位专业营养师，请根据以下信息推荐今日菜式：身高${height}cm，体重${weight}kg，BMI${bmi.toFixed(1)}（${label}），偏好${filterLabel}。` +
    `推荐3个分类，每类3道菜。严格返回JSON，不要其它说明：` +
    `{"categories":[{"icon":"🥗","title":"简单快手","desc":"...","dishes":[{"name":"...","reason":"..."}]},...]}`;

  const apiUrl = env.AI_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1200,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`AI API ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  let categories = [];
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    categories = parsed.categories || [];
  } catch (e) {
    throw new Error('AI 返回格式异常');
  }

  return json({
    ok: true,
    bmi: bmi.toFixed(1),
    label,
    categories,
  });
}
