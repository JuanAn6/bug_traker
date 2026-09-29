/**
 * The whole schema, in one place for drizzle-kit and for the typed `db` instance.
 *
 * Load order matters only for the foreign keys: users has no outbound edges, projects
 * points at users, custom-fields at projects, issues at all three, and so on. The one
 * deliberate gap is userPrefs.defaultProjectId, which carries no FK so that users and
 * projects do not become circular modules.
 */
export * from './enums';
export * from './users';
export * from './projects';
export * from './custom-fields';
export * from './issues';
export * from './comments';
export * from './attachments';
export * from './history';
export * from './notifications';
export * from './workflow';
export * from './infra';
