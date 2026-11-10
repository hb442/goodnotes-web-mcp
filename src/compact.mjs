import { z } from 'zod';
import { GoodnotesError } from './errors.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export function installCompactTools(server, actions, invoke) {
  const route = (action) =>
    actions.get(action) ??
    (() => {
      throw new GoodnotesError(
        'UNKNOWN_ACTION',
        'Use goodnotes_help to choose a supported action.',
      );
    })();
  const publish = (name, description, inputSchema, fn, readOnly, destructive = false) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: true },
      },
      invoke(fn),
    );
  publish(
    'goodnotes_help',
    'Discover Goodnotes actions by keyword, or request full input schemas for up to three named actions. Use the returned route (goodnotes_read/write) with the same action and parameters. No browser is opened.',
    {
      query: z.string().max(100).optional(),
      actions: z.array(z.string().max(80)).min(1).max(3).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
    async ({ query, actions: names, offset, limit }) => {
      if (names && query)
        throw new GoodnotesError('INVALID_HELP_QUERY', 'Use names or a search query, not both.');
      if (names)
        return json({
          actions: names.map((name) => {
            const a = route(name);
            return {
              name: a.name,
              description: a.description,
              route: a.readOnly ? 'goodnotes_read' : 'goodnotes_write',
              destructive: a.destructive,
              inputSchema: z.toJSONSchema(a.schema, { io: 'input' }),
            };
          }),
        });
      const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [...actions.values()].filter((a) =>
        terms.every((term) => (a.name + ' ' + a.description).toLowerCase().includes(term)),
      );
      return json({
        mode: 'compact',
        total: matches.length,
        offset,
        nextOffset: offset + limit < matches.length ? offset + limit : null,
        actions: matches.slice(offset, offset + limit).map((a) => ({
          name: a.name,
          description: a.description,
          route: a.readOnly ? 'goodnotes_read' : 'goodnotes_write',
          destructive: a.destructive,
        })),
        next: 'Request goodnotes_help with action names for exact parameters. Inputs are validated against the same schemas and guards as full mode.',
      });
    },
    true,
  );
  for (const readOnly of [true, false])
    publish(
      readOnly ? 'goodnotes_read' : 'goodnotes_write',
      readOnly
        ? 'Run one read-only Goodnotes action discovered with goodnotes_help. Strictly validates that action’s parameters and refuses any write/UI-edit action.'
        : 'Run one explicitly chosen Goodnotes action that may edit the UI or document, discovered with goodnotes_help. The original permissions, expected-content checks, operation receipts and verification still apply.',
      {
        action: z.string().min(1).max(80),
        parameters: z.record(z.string(), z.unknown()).default({}),
      },
      async ({ action, parameters }, options) => {
        const a = route(action);
        if (a.readOnly !== readOnly)
          throw new GoodnotesError(
            'WRONG_ACTION_ROUTE',
            'Use ' + (a.readOnly ? 'goodnotes_read' : 'goodnotes_write') + ' for this action.',
          );
        const parsed = a.schema.safeParse(parameters);
        if (!parsed.success)
          throw new GoodnotesError(
            'INVALID_ACTION_INPUT',
            'The parameters do not match this action. Request its schema with goodnotes_help.',
            { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
          );
        return a.fn(parsed.data, options);
      },
      readOnly,
      !readOnly,
    );
}
