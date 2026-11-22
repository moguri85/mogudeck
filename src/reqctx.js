'use strict';
// Contexto de la petición en curso (para que las vistas sepan si hay un jugador con sesión)
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
module.exports = { run: (ctx, fn) => als.run(ctx, fn), get: () => als.getStore() || {} };
