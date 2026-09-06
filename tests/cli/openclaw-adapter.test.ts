import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pathPosix from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOpenClawAdapter,
  isOpenClawConfigured,
  mergeOpenClawConfig,
  mutateOpenClawConfig,
  openclawConfigPath,
  openclawConfigScope,
} from '../../src/cli/agents/openclaw.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';
import { AgentEnvironment } from '../../src/cli/agents/types.js';

const dirs: string[] = [];
const workspace = async () => {
  const d = await mkdtemp(pathPosix.join(tmpdir(), 'knowl-openclaw-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('openclaw adapter', () => {
  let home: string;
  const savedConfigPath = process.env.OPENCLAW_CONFIG_PATH;

  beforeEach(async () => {
    home = await workspace();
    delete process.env.OPENCLAW_CONFIG_PATH;
  });

  afterEach(() => {
    if (savedConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = savedConfigPath;
  });

  const env = (installed: boolean): AgentEnvironment => ({
    platform: process.platform,
    homeDir: home,
    appDataDir: pathPosix.join(home, 'appdata'),
    commandExists: async cmd => cmd === 'openclaw' && installed,
  });

  it('is a supported agent name', () => {
    expect(parseAgentNames(['openclaw'])).toEqual(['openclaw']);
  });

  describe('openclawConfigPath and scope resolution', () => {
    it('honors process.env.OPENCLAW_CONFIG_PATH override first', async () => {
      const custom = pathPosix.join(home, 'custom', 'openclaw.json');
      process.env.OPENCLAW_CONFIG_PATH = custom;
      expect(openclawConfigPath(env(true), '/some/repo')).toBe(custom);
    });

    it('uses project-scoped openclaw.json if it exists in projectRoot', async () => {
      const projectRoot = await workspace();
      const projectConfig = pathPosix.join(projectRoot, 'openclaw.json');
      await writeFile(projectConfig, '{}', 'utf8');

      const resolved = openclawConfigPath(env(true), projectRoot);
      expect(resolved).toBe(projectConfig);
      expect(openclawConfigScope(resolved, projectRoot)).toBe('project');
    });

    it('falls back to global ~/.openclaw/openclaw.json when project has no openclaw.json', async () => {
      const projectRoot = await workspace();
      const expected = pathPosix.join(home, '.openclaw', 'openclaw.json');

      const resolved = openclawConfigPath(env(true), projectRoot);
      expect(resolved).toBe(expected);
      expect(openclawConfigScope(resolved, projectRoot)).toBe('global');
    });
  });

  describe('isOpenClawConfigured', () => {
    it('returns false for non-objects or empty structures', () => {
      expect(isOpenClawConfigured(null)).toBe(false);
      expect(isOpenClawConfigured(undefined)).toBe(false);
      expect(isOpenClawConfigured({})).toBe(false);
      expect(isOpenClawConfigured({ plugins: {} })).toBe(false);
      expect(isOpenClawConfigured({ plugins: { entries: {} } })).toBe(false);
    });

    it('returns false if knowl plugin is disabled', () => {
      expect(isOpenClawConfigured({
        plugins: {
          entries: {
            knowl: {
              enabled: false,
              hooks: {
                allowConversationAccess: true,
                allowPromptInjection: true,
                timeouts: { before_tool_call: 5000 },
              },
            },
          },
        },
      })).toBe(false);
    });

    it('returns false if permission gates are missing or false', () => {
      expect(isOpenClawConfigured({
        plugins: {
          entries: {
            knowl: {
              enabled: true,
              hooks: {
                allowConversationAccess: false,
                allowPromptInjection: true,
                timeouts: { before_tool_call: 5000 },
              },
            },
          },
        },
      })).toBe(false);

      expect(isOpenClawConfigured({
        plugins: {
          entries: {
            knowl: {
              enabled: true,
              hooks: {
                allowConversationAccess: true,
                allowPromptInjection: false,
                timeouts: { before_tool_call: 5000 },
              },
            },
          },
        },
      })).toBe(false);
    });

    it('returns false if before_tool_call timeout is missing or not 5000', () => {
      expect(isOpenClawConfigured({
        plugins: {
          entries: {
            knowl: {
              enabled: true,
              hooks: {
                allowConversationAccess: true,
                allowPromptInjection: true,
              },
            },
          },
        },
      })).toBe(false);

      expect(isOpenClawConfigured({
        plugins: {
          entries: {
            knowl: {
              enabled: true,
              hooks: {
                allowConversationAccess: true,
                allowPromptInjection: true,
                timeouts: { before_tool_call: 15000 },
              },
            },
          },
        },
      })).toBe(false);
    });

    it('returns true when all required settings are present', () => {
      expect(isOpenClawConfigured({
        plugins: {
          entries: {
            knowl: {
              enabled: true,
              hooks: {
                allowConversationAccess: true,
                allowPromptInjection: true,
                timeouts: { before_tool_call: 5000 },
              },
            },
          },
        },
      })).toBe(true);
    });
  });

  describe('mutateOpenClawConfig', () => {
    it('returns unchanged if already configured', () => {
      const data: Record<string, any> = {
        plugins: {
          entries: {
            knowl: {
              enabled: true,
              hooks: {
                allowConversationAccess: true,
                allowPromptInjection: true,
                timeouts: { before_tool_call: 5000 },
              },
            },
          },
        },
      };
      const result = mutateOpenClawConfig(data);
      expect(result.changed).toBe(false);
      expect(result.status).toBe('unchanged');
    });

    it('returns configured for empty object and writes all fields', () => {
      const data: Record<string, any> = {};
      const result = mutateOpenClawConfig(data);
      expect(result.changed).toBe(true);
      expect(result.status).toBe('configured');
      expect(isOpenClawConfigured(data)).toBe(true);
    });

    it('returns updated for partially configured object', () => {
      const data: Record<string, any> = {
        plugins: {
          entries: {
            knowl: {
              enabled: false,
            },
          },
        },
      };
      const result = mutateOpenClawConfig(data);
      expect(result.changed).toBe(true);
      expect(result.status).toBe('updated');
      expect(isOpenClawConfigured(data)).toBe(true);
    });
  });

  describe('mergeOpenClawConfig', () => {
    it('creates a new config file when none exists', async () => {
      const configPath = pathPosix.join(home, 'openclaw.json');
      const status = await mergeOpenClawConfig(configPath);
      expect(status).toBe('configured');

      const saved = JSON.parse(await readFile(configPath, 'utf8'));
      expect(saved.plugins.entries.knowl).toEqual({
        enabled: true,
        hooks: {
          allowConversationAccess: true,
          allowPromptInjection: true,
          timeouts: {
            before_tool_call: 5000,
          },
        },
      });
    });

    it('preserves unrelated user keys at all levels and creates a backup file', async () => {
      const configPath = pathPosix.join(home, 'openclaw.json');
      const initial = {
        model: 'claude-3-7-sonnet',
        gateway: {
          port: 18789,
          auth: 'token',
        },
        plugins: {
          loadPath: ['/opt/plugins'],
          entries: {
            custom_plugin: {
              enabled: true,
              setting: 42,
            },
            knowl: {
              customNote: 'keep me',
              hooks: {
                otherHookSetting: true,
                timeouts: {
                  session_start: 3000,
                },
              },
            },
          },
        },
      };

      await writeFile(configPath, JSON.stringify(initial, null, 2), 'utf8');

      const status = await mergeOpenClawConfig(configPath);
      expect(status).toBe('updated');

      const saved = JSON.parse(await readFile(configPath, 'utf8'));
      // Unrelated top-level keys preserved
      expect(saved.model).toBe('claude-3-7-sonnet');
      expect(saved.gateway).toEqual({ port: 18789, auth: 'token' });
      // Unrelated plugin keys preserved
      expect(saved.plugins.loadPath).toEqual(['/opt/plugins']);
      expect(saved.plugins.entries.custom_plugin).toEqual({ enabled: true, setting: 42 });
      // Existing knowl options preserved
      expect(saved.plugins.entries.knowl.customNote).toBe('keep me');
      expect(saved.plugins.entries.knowl.hooks.otherHookSetting).toBe(true);
      expect(saved.plugins.entries.knowl.hooks.timeouts.session_start).toBe(3000);
      // Required knowl configuration applied
      expect(saved.plugins.entries.knowl.enabled).toBe(true);
      expect(saved.plugins.entries.knowl.hooks.allowConversationAccess).toBe(true);
      expect(saved.plugins.entries.knowl.hooks.allowPromptInjection).toBe(true);
      expect(saved.plugins.entries.knowl.hooks.timeouts.before_tool_call).toBe(5000);

      // Backup created
      await expect(access(`${configPath}.backup`)).resolves.toBeUndefined();
    });

    it('is idempotent and returns unchanged on repeated execution', async () => {
      const configPath = pathPosix.join(home, 'openclaw.json');
      await mergeOpenClawConfig(configPath);
      const textBefore = await readFile(configPath, 'utf8');

      const status = await mergeOpenClawConfig(configPath);
      expect(status).toBe('unchanged');
      const textAfter = await readFile(configPath, 'utf8');
      expect(textAfter).toBe(textBefore);
    });

    it('leaves unparseable JSON file untouched and throws an error', async () => {
      const configPath = pathPosix.join(home, 'openclaw.json');
      const invalidJson = '{\n  "corrupt": true,\n';
      await writeFile(configPath, invalidJson, 'utf8');

      await expect(mergeOpenClawConfig(configPath)).rejects.toThrow(/Could not parse/);

      // File was left untouched
      const textAfter = await readFile(configPath, 'utf8');
      expect(textAfter).toBe(invalidJson);
    });
  });

  describe('createOpenClawAdapter', () => {
    it('detects installation status and configuration', async () => {
      const adapter = createOpenClawAdapter(env(true));
      const root = await workspace();

      // Initially not configured
      const detection1 = await adapter.detect(root);
      expect(detection1.installed).toBe(true);
      expect(detection1.configured).toBe(false);

      // Configure
      const result = await adapter.configure(root);
      expect(result.status).toBe('configured');
      expect(result.agent).toBe('openclaw');

      // Now configured
      const detection2 = await adapter.detect(root);
      expect(detection2.configured).toBe(true);
      expect(await adapter.verify(root)).toBe(true);
      expect(await adapter.lifecycleCapability!(root)).toBe('supported');
      expect(await adapter.verifyLifecycle!(root)).toBe(true);
      expect((await adapter.configureLifecycle!(root)).status).toBe('unchanged');
    });

    it('fails safely when configuring an unparseable file without crashing', async () => {
      const adapter = createOpenClawAdapter(env(true));
      const root = await workspace();
      const projectConfig = pathPosix.join(root, 'openclaw.json');
      const malformed = '{"unclosed": "brace"';
      await writeFile(projectConfig, malformed, 'utf8');

      const result = await adapter.configure(root);
      expect(result.status).toBe('failed');
      expect(result.message).toContain('Could not configure');

      // Verify file is still untouched
      expect(await readFile(projectConfig, 'utf8')).toBe(malformed);
      expect(await adapter.verify(root)).toBe(false);
    });
  });
});
