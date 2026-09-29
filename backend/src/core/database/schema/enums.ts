/**
 * The value lists behind every MySQL ENUM column.
 *
 * Order is load-bearing: MariaDB stores the ordinal, and the *Rank columns on `issues`
 * are the index into these same arrays (see domain/rank.ts). Reordering any of them is a
 * data migration, not a refactor.
 *
 * Five arrays come straight from the copied shared/config.ts, so they cannot drift from
 * the frontend. The rest have no array there (only a union type), so they are declared
 * here with a compile-time exhaustiveness assertion: add a member to the union in
 * models.ts and this file stops compiling.
 */
import {
  CUSTOM_FIELD_TYPES,
  PRIORITIES,
  PROJECT_STATUSES,
  RELATIONSHIPS,
  REPRODUCIBILITY,
  RESOLUTIONS,
  SEVERITIES,
  SPRINT_STATES,
  STATUSES,
} from '../../../shared/config';
import type {
  Action,
  Density,
  HistoryType,
  NotifyEvent,
  Theme,
  ViewState,
} from '../../../shared/models';

export {
  CUSTOM_FIELD_TYPES,
  PRIORITIES,
  PROJECT_STATUSES,
  RELATIONSHIPS,
  REPRODUCIBILITY,
  RESOLUTIONS,
  SEVERITIES,
  SPRINT_STATES,
  STATUSES,
};

/** Fails to compile with a readable error when `Union` has members missing from `List`. */
type AssertComplete<Union extends string, List extends readonly Union[]> =
  Exclude<Union, List[number]> extends never
    ? List
    : ['missing enum members:', Exclude<Union, List[number]>];

const complete = <Union extends string>() =>
  <List extends readonly Union[]>(list: AssertComplete<Union, List>) => list as List;

export const VIEW_STATES = complete<ViewState>()(['public', 'private'] as const);
export const THEMES = complete<Theme>()(['light', 'dark', 'system'] as const);
export const DENSITIES = complete<Density>()(['compact', 'comfortable'] as const);
export const NOTIFY_EVENTS = complete<NotifyEvent>()([
  'assigned', 'mentioned', 'status', 'note', 'attachment',
] as const);

export const HISTORY_TYPES = complete<HistoryType>()([
  'created', 'field', 'note_added', 'note_edited', 'note_deleted', 'attachment_added',
  'attachment_deleted', 'attachment_renamed', 'attachment_version', 'relationship_added',
  'relationship_deleted', 'tag_added', 'tag_removed', 'monitor_added', 'monitor_removed', 'cloned',
] as const);

/** The 22 permission thresholds. Keys of workflow.thresholds, one row each. */
export const ACTIONS = complete<Action>()([
  'view', 'report', 'update', 'assign', 'changeStatus', 'close', 'reopen', 'delete', 'move',
  'addNote', 'editOthersNotes', 'viewPrivate', 'uploadFile', 'deleteOthersFiles', 'monitorOthers',
  'manageRelationships', 'manageTags', 'manageSprints', 'manageProject', 'manageUsers',
  'manageWorkflow', 'manageCustomFields',
] as const);
