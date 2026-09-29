import type {
  AccessLevel, Action, ColumnId, CustomFieldType, FilterCriteria, HomeWidget, Priority, ProjectStatus,
  RelationshipType, Reproducibility, Resolution, Severity, SprintState, Status, UserPrefs, WorkflowConfig,
} from './models';

export const STATUSES: Status[] = ['new', 'feedback', 'acknowledged', 'confirmed', 'assigned', 'resolved', 'closed'];
export const RESOLUTIONS: Resolution[] = [
  'open', 'fixed', 'reopened', 'unable_to_reproduce', 'not_fixable', 'duplicate', 'no_change_required', 'suspended', 'wont_fix',
];
export const PRIORITIES: Priority[] = ['none', 'low', 'normal', 'high', 'urgent', 'immediate'];
export const SEVERITIES: Severity[] = ['feature', 'trivial', 'text', 'tweak', 'minor', 'major', 'crash', 'block'];
export const REPRODUCIBILITY: Reproducibility[] = ['always', 'sometimes', 'random', 'have_not_tried', 'unable_to_reproduce', 'na'];
export const RELATIONSHIPS: RelationshipType[] = ['related_to', 'parent_of', 'child_of', 'duplicate_of', 'has_duplicate'];
export const PROJECT_STATUSES: ProjectStatus[] = ['development', 'release', 'stable', 'obsolete'];
export const SPRINT_STATES: SprintState[] = ['planned', 'active', 'closed'];
export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ['string', 'number', 'list', 'checkbox', 'date'];
export const ACCESS_LEVELS: AccessLevel[] = [10, 25, 40, 55, 70, 90];
export const ACCESS_NAMES: Record<AccessLevel, string> = {
  10: 'viewer', 25: 'reporter', 40: 'updater', 55: 'developer', 70: 'manager', 90: 'administrator',
};
export const HOME_WIDGETS: HomeWidget[] = ['assigned', 'reported', 'unassigned', 'recent', 'monitored', 'feedback', 'due'];

export const REVERSE_RELATIONSHIP: Record<RelationshipType, RelationshipType> = {
  related_to: 'related_to', parent_of: 'child_of', child_of: 'parent_of', duplicate_of: 'has_duplicate', has_duplicate: 'duplicate_of',
};

export const statusRank = (s: Status) => STATUSES.indexOf(s);
export const isResolved = (s: Status) => statusRank(s) >= statusRank('resolved');

export const ALL_COLUMNS: ColumnId[] = [
  'id', 'project', 'category', 'summary', 'status', 'resolution', 'priority', 'severity', 'reproducibility',
  'reporter', 'handler', 'sprint', 'targetVersion', 'fixedInVersion', 'tags', 'attachments', 'notes',
  'created', 'updated', 'dueDate', 'storyPoints', 'viewState',
];
export const DEFAULT_COLUMNS: ColumnId[] = [
  'id', 'priority', 'attachments', 'notes', 'category', 'severity', 'status', 'handler', 'updated', 'summary',
];
export const COMPACT_COLUMNS: ColumnId[] = ['id', 'priority', 'status', 'summary', 'updated'];

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const BLOCKED_EXTENSIONS = ['exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'ps1', 'vbs', 'jar', 'sh'];

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
];

export const AVATAR_COLORS = ['#3875d7', '#c0662b', '#2e8b57', '#8e44ad', '#b8860b', '#c0392b', '#16a085', '#6d4c41'];

export function defaultPrefs(): UserPrefs {
  return {
    language: 'en', theme: 'system', density: 'compact', defaultProjectId: null, pageSize: 25,
    homeWidgets: ['assigned', 'reported', 'unassigned', 'recent', 'monitored', 'due'],
    notify: { assigned: true, mentioned: true, status: true, note: true, attachment: true },
    notesNewestFirst: false,
  };
}

export function emptyCriteria(): FilterCriteria {
  return {
    projectIds: [], includeSubprojects: true, sprintIds: [], categories: [], statuses: [], hideStatus: 'closed',
    resolutions: [], priorities: [], severities: [], reproducibility: [], reporterIds: [], handlerIds: [],
    monitorId: null, tags: [], tagsMode: 'any', targetVersion: '', fixedInVersion: '', platform: '', os: '',
    viewState: '', createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', dueFrom: '', dueTo: '',
    overdueOnly: false, hasAttachments: null, relationship: '', customFieldId: null, customFieldValue: '',
    text: '', searchNotes: false,
  };
}

const ALL_THRESHOLDS: Record<Action, AccessLevel> = {
  view: 10, report: 25, update: 40, assign: 55, changeStatus: 40, close: 55, reopen: 25, delete: 70, move: 55,
  addNote: 25, editOthersNotes: 70, viewPrivate: 55, uploadFile: 25, deleteOthersFiles: 70, monitorOthers: 55,
  manageRelationships: 40, manageTags: 40, manageSprints: 70, manageProject: 70, manageUsers: 90,
  manageWorkflow: 90, manageCustomFields: 90,
};

export function defaultWorkflow(): WorkflowConfig {
  return {
    transitions: {
      new: ['feedback', 'acknowledged', 'confirmed', 'assigned', 'resolved', 'closed'],
      feedback: ['new', 'acknowledged', 'confirmed', 'assigned', 'resolved', 'closed'],
      acknowledged: ['feedback', 'confirmed', 'assigned', 'resolved', 'closed'],
      confirmed: ['feedback', 'acknowledged', 'assigned', 'resolved', 'closed'],
      assigned: ['feedback', 'acknowledged', 'confirmed', 'resolved', 'closed'],
      resolved: ['feedback', 'assigned', 'closed'],
      closed: ['feedback'],
    },
    thresholds: { ...ALL_THRESHOLDS },
    statusColors: {
      new: '#fcbdbd', feedback: '#e3b7eb', acknowledged: '#ffcd85', confirmed: '#fff494',
      assigned: '#c2dfff', resolved: '#d2f5b0', closed: '#c9ccc4',
    },
    resolvedStatus: 'resolved',
    autoAssignStatus: true,
    boardColumns: ['new', 'feedback', 'confirmed', 'assigned', 'resolved', 'closed'],
    wipLimits: { assigned: 12 },
  };
}
