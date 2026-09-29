import { ApplicationConfig, ErrorHandler, Injectable, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { Toasts } from './core/toast.service';

/** Surface unexpected errors to the user instead of failing silently. */
@Injectable()
class AppErrorHandler implements ErrorHandler {
  private readonly toasts = inject(Toasts);
  handleError(error: unknown): void {
    console.error(error);
    this.toasts.error(error instanceof Error ? error.message : String(error));
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ anchorScrolling: 'enabled' })),
    { provide: ErrorHandler, useClass: AppErrorHandler },
  ],
};
