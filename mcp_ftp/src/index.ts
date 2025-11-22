import Fastify from 'fastify';
import { FastMCP } from 'modelcontextprotocol';

const mcp = new FastMCP('FTPBridge');

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

app.post('/invoke', async (request, reply) => {
  const body = request.body as { tool: string; arguments: Record<string, unknown> };
  const result = await mcp.invokeTool(body.tool, body.arguments ?? {});
  return reply.send(result);
});

const port = Number(process.env.PORT || 8007);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err, 'Failed to start FTP MCP bridge');
  process.exit(1);
});
