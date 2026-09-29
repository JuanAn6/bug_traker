import { Routes } from '@angular/router';
import { authGuard, dirtyGuard, permGuard } from './core/guards';

const page = (tab: string, icon: string) => ({ tab, icon });

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login').then((m) => m.Login), data: { noTab: true } },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', loadComponent: () => import('./pages/home/home').then((m) => m.Home), data: page('nav.home', 'home') },
      { path: 'issues', loadComponent: () => import('./pages/issues/issues').then((m) => m.Issues), data: page('nav.issues', 'list') },
      { path: 'issues/:id', loadComponent: () => import('./pages/issue-view/issue-view').then((m) => m.IssueView), data: page('nav.issue', 'bug') },
      { path: 'issues/:id/edit', loadComponent: () => import('./pages/issue-form/issue-form').then((m) => m.IssueForm), canDeactivate: [dirtyGuard], data: page('issue.edit', 'edit') },
      { path: 'report', loadComponent: () => import('./pages/issue-form/issue-form').then((m) => m.IssueForm), canDeactivate: [dirtyGuard], canActivate: [permGuard('report')], data: page('nav.report', 'plus') },
      { path: 'board', loadComponent: () => import('./pages/board/board').then((m) => m.Board), data: page('nav.board', 'board') },
      { path: 'sprints', loadComponent: () => import('./pages/sprints/sprints').then((m) => m.Sprints), data: page('nav.sprints', 'zap') },
      { path: 'sprints/:id', loadComponent: () => import('./pages/sprint-detail/sprint-detail').then((m) => m.SprintDetail), data: page('nav.sprint', 'zap') },
      { path: 'sprints/:id/board', loadComponent: () => import('./pages/board/board').then((m) => m.Board), data: page('nav.board', 'board') },
      { path: 'projects', loadComponent: () => import('./pages/projects/projects').then((m) => m.Projects), data: page('nav.projects', 'database') },
      { path: 'projects/:id', loadComponent: () => import('./pages/project-edit/project-edit').then((m) => m.ProjectEdit), canDeactivate: [dirtyGuard], data: page('nav.project', 'database') },
      { path: 'roadmap', loadComponent: () => import('./pages/roadmap/roadmap').then((m) => m.Roadmap), data: page('nav.roadmap', 'map') },
      { path: 'changelog', loadComponent: () => import('./pages/changelog/changelog').then((m) => m.Changelog), data: page('nav.changelog', 'file-text') },
      { path: 'summary', loadComponent: () => import('./pages/summary/summary').then((m) => m.Summary), data: page('nav.summary', 'chart') },
      { path: 'calendar', loadComponent: () => import('./pages/calendar/calendar').then((m) => m.Calendar), data: page('nav.calendar', 'calendar') },
      { path: 'notifications', loadComponent: () => import('./pages/notifications/notifications').then((m) => m.NotificationsPage), data: page('nav.notifications', 'bell') },
      { path: 'users', loadComponent: () => import('./pages/users/users').then((m) => m.Users), canActivate: [permGuard('manageUsers')], data: page('nav.users', 'users') },
      { path: 'users/:id', loadComponent: () => import('./pages/user-detail/user-detail').then((m) => m.UserDetail), data: page('nav.user', 'user') },
      { path: 'account', loadComponent: () => import('./pages/account/account').then((m) => m.Account), data: page('nav.account', 'user') },
      { path: 'admin/workflow', loadComponent: () => import('./pages/admin/workflow/workflow').then((m) => m.WorkflowAdmin), canActivate: [permGuard('manageWorkflow')], data: page('nav.workflow', 'workflow') },
      { path: 'admin/custom-fields', loadComponent: () => import('./pages/admin/custom-fields/custom-fields').then((m) => m.CustomFieldsAdmin), canActivate: [permGuard('manageCustomFields')], data: page('nav.customFields', 'columns') },
      { path: 'admin/tags', loadComponent: () => import('./pages/admin/tags/tags').then((m) => m.TagsAdmin), canActivate: [permGuard('manageTags')], data: page('nav.tags', 'tag') },
      { path: 'settings', loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings), data: page('nav.settings', 'sliders') },
      { path: 'denied', loadComponent: () => import('./pages/denied/denied').then((m) => m.Denied), data: { noTab: true } },
      { path: '**', loadComponent: () => import('./pages/not-found/not-found').then((m) => m.NotFound), data: { noTab: true } },
    ],
  },
];
