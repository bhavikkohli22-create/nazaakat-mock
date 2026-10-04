// Local server: node server.js   (PORT env optional, default 3000)
const http = require("http");
const { handler, CFG } = require("./lib/mock");

const port = Number(process.env.PORT || 3000);
http.createServer(handler).listen(port, () => {
  console.log(`nazaakat mock Delhivery listening on http://localhost:${port}`);
  console.log(`  MCP:    POST http://localhost:${port}/mcp`);
  console.log(`  Health: GET  http://localhost:${port}/health`);
  console.log(`  Stage minutes: ${CFG.STAGE_MINUTES}  Timeout delay: ${CFG.TIMEOUT_MS}ms  Warehouse: ${CFG.WAREHOUSE}`);
});
