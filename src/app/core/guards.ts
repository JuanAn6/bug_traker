import { inject } from '@angular/core';
import { CanActivateFn, CanDeactivateFn, Router } from '@angular/router';
import { Auth } from './auth.service';
import type { Action } from './models';
import { Permissions } from './permissions.service';
import { Tabs } from './tabs.service';
import { I18n } from '../i18n/i18n.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const router = inject(Router);
  return inject(Auth).user() ? true : router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

export const permGuard = (action: Action): CanActivateFn => () =>
  inject(Permissions).can(action) || inject(Router).createUrlTree(['/denied']);

export interface DirtyAware {
  isDirty(): boolean;
}

export const dirtyGuard: CanDeactivateFn<DirtyAware> = (component) => {
  const tabs = inject(Tabs);
  if (tabs.bypassDirty) {
    tabs.bypassDirty = false;
    return true;
  }
  if (!component.isDirty()) return true;
  const ok = confirm(inject(I18n).t('common.discardChanges'));
  if (ok) tabs.setDirty(false);
  return ok;
};
