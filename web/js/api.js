/* api.js — サーバー REST API の薄いラッパー。 */

const API = {
  async _json(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      const err = new Error("unauthorized");
      err.code = 401;
      throw err;
    }
    if (!res.ok) {
      const err = new Error("http_" + res.status);
      err.code = res.status;
      throw err;
    }
    return res.json();
  },

  login(username, password) {
    return this._json("POST", "/api/login", { username, password });
  },
  logout() {
    return this._json("POST", "/api/logout");
  },
  me() {
    return this._json("GET", "/api/me");
  },
  // since 以降の更新を取得しつつ、未同期の変更を push
  sync(since, changes) {
    return this._json("POST", "/api/sync", { since, changes });
  },

  tags() {
    return this._json("GET", "/api/tags");
  },

  // 管理（管理者のみ）
  adminUsers() {
    return this._json("GET", "/api/admin/users");
  },
  adminCreateUser(data) {
    return this._json("POST", "/api/admin/users", data);
  },
  adminUpdateUser(id, data) {
    return this._json("PUT", `/api/admin/users/${id}`, data);
  },
  adminDeleteUser(id) {
    return this._json("DELETE", `/api/admin/users/${id}`);
  },
  adminCreateTag(data) {
    return this._json("POST", "/api/admin/tags", data);
  },
  adminUpdateTag(id, data) {
    return this._json("PUT", `/api/admin/tags/${id}`, data);
  },
  adminDeleteTag(id) {
    return this._json("DELETE", `/api/admin/tags/${id}`);
  },
};

window.API = API;
