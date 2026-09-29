CREATE TABLE `refreshTokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tokenHash` char(64) NOT NULL,
	`family` char(36) NOT NULL,
	`userAgent` varchar(255),
	`ip` varchar(45),
	`expiresAt` datetime(3) NOT NULL,
	`revokedAt` datetime(3),
	`created` datetime(3) NOT NULL,
	CONSTRAINT `refreshTokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `refreshTokens_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `userPrefs` (
	`userId` int NOT NULL,
	`language` varchar(8) NOT NULL DEFAULT 'en',
	`theme` enum('light','dark','system') NOT NULL DEFAULT 'system',
	`density` enum('compact','comfortable') NOT NULL DEFAULT 'compact',
	`defaultProjectId` int,
	`pageSize` smallint NOT NULL DEFAULT 25,
	`notesNewestFirst` boolean NOT NULL DEFAULT false,
	`homeWidgets` varchar(255) NOT NULL,
	`notifyAssigned` boolean NOT NULL DEFAULT true,
	`notifyMentioned` boolean NOT NULL DEFAULT true,
	`notifyStatus` boolean NOT NULL DEFAULT true,
	`notifyNote` boolean NOT NULL DEFAULT true,
	`notifyAttachment` boolean NOT NULL DEFAULT true,
	CONSTRAINT `userPrefs_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`username` varchar(64) NOT NULL,
	`realName` varchar(128) NOT NULL,
	`email` varchar(190) NOT NULL,
	`passwordHash` varchar(255),
	`accessLevel` tinyint NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`avatarColor` varchar(16) NOT NULL,
	`lastVisit` datetime(3),
	`created` datetime(3) NOT NULL,
	`tokenVersion` int NOT NULL DEFAULT 0,
	`deletedAt` datetime(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_username_unique` UNIQUE(`username`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `projectCategories` (
	`projectId` int NOT NULL,
	`name` varchar(64) NOT NULL,
	`defaultHandlerId` int,
	`sortOrder` smallint NOT NULL,
	CONSTRAINT `projectCategories_projectId_name_pk` PRIMARY KEY(`projectId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `projectMembers` (
	`projectId` int NOT NULL,
	`userId` int NOT NULL,
	`accessLevel` tinyint NOT NULL,
	CONSTRAINT `projectMembers_projectId_userId_pk` PRIMARY KEY(`projectId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `projectVersions` (
	`projectId` int NOT NULL,
	`name` varchar(64) NOT NULL,
	`date` date,
	`released` boolean NOT NULL DEFAULT false,
	`obsolete` boolean NOT NULL DEFAULT false,
	`description` varchar(512) NOT NULL DEFAULT '',
	`sortOrder` smallint NOT NULL,
	CONSTRAINT `projectVersions_projectId_name_pk` PRIMARY KEY(`projectId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`key` varchar(10) NOT NULL,
	`keyUpper` varchar(10) NOT NULL,
	`description` longtext,
	`status` enum('development','release','stable','obsolete') NOT NULL,
	`viewState` enum('public','private') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`parentId` int,
	`created` datetime(3) NOT NULL,
	`deletedAt` datetime(3),
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_keyUpper_unique` UNIQUE(`keyUpper`)
);
--> statement-breakpoint
CREATE TABLE `sprints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`name` varchar(128) NOT NULL,
	`goal` varchar(512) NOT NULL DEFAULT '',
	`start` date NOT NULL,
	`end` date NOT NULL,
	`state` enum('planned','active','closed') NOT NULL,
	`capacity` smallint NOT NULL DEFAULT 0,
	`deletedAt` datetime(3),
	CONSTRAINT `sprints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customFields` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(64) NOT NULL,
	`type` enum('string','number','list','checkbox','date') NOT NULL,
	`options` varchar(1024) NOT NULL DEFAULT '',
	`required` boolean NOT NULL DEFAULT false,
	`defaultValue` varchar(255) NOT NULL DEFAULT '',
	CONSTRAINT `customFields_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projectCustomFields` (
	`projectId` int NOT NULL,
	`customFieldId` int NOT NULL,
	`sortOrder` smallint NOT NULL DEFAULT 0,
	CONSTRAINT `projectCustomFields_projectId_customFieldId_pk` PRIMARY KEY(`projectId`,`customFieldId`)
);
--> statement-breakpoint
CREATE TABLE `issueCustomValues` (
	`issueId` int NOT NULL,
	`customFieldId` int NOT NULL,
	`value` varchar(1024) NOT NULL DEFAULT '',
	CONSTRAINT `issueCustomValues_issueId_customFieldId_pk` PRIMARY KEY(`issueId`,`customFieldId`)
);
--> statement-breakpoint
CREATE TABLE `issueMonitors` (
	`issueId` int NOT NULL,
	`userId` int NOT NULL,
	CONSTRAINT `issueMonitors_issueId_userId_pk` PRIMARY KEY(`issueId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `issueRelationships` (
	`issueId` int NOT NULL,
	`otherIssueId` int NOT NULL,
	`type` enum('related_to','parent_of','child_of','duplicate_of','has_duplicate') NOT NULL,
	`created` datetime(3) NOT NULL,
	CONSTRAINT `issueRelationships_issueId_otherIssueId_pk` PRIMARY KEY(`issueId`,`otherIssueId`),
	CONSTRAINT `chk_rel_no_self` CHECK(`issueRelationships`.`issueId` <> `issueRelationships`.`otherIssueId`)
);
--> statement-breakpoint
CREATE TABLE `issueTags` (
	`issueId` int NOT NULL,
	`tag` varchar(64) NOT NULL,
	`sortOrder` smallint NOT NULL DEFAULT 0,
	CONSTRAINT `issueTags_issueId_tag_pk` PRIMARY KEY(`issueId`,`tag`)
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`sprintId` int,
	`category` varchar(64) NOT NULL DEFAULT '',
	`summary` varchar(255) NOT NULL,
	`description` longtext,
	`stepsToReproduce` longtext,
	`additionalInfo` longtext,
	`status` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed') NOT NULL,
	`statusRank` tinyint NOT NULL,
	`resolution` enum('open','fixed','reopened','unable_to_reproduce','not_fixable','duplicate','no_change_required','suspended','wont_fix') NOT NULL,
	`resolutionRank` tinyint NOT NULL,
	`priority` enum('none','low','normal','high','urgent','immediate') NOT NULL,
	`priorityRank` tinyint NOT NULL,
	`severity` enum('feature','trivial','text','tweak','minor','major','crash','block') NOT NULL,
	`severityRank` tinyint NOT NULL,
	`reproducibility` enum('always','sometimes','random','have_not_tried','unable_to_reproduce','na') NOT NULL,
	`reproducibilityRank` tinyint NOT NULL,
	`platform` varchar(64) NOT NULL DEFAULT '',
	`os` varchar(64) NOT NULL DEFAULT '',
	`osBuild` varchar(64) NOT NULL DEFAULT '',
	`productVersion` varchar(64) NOT NULL DEFAULT '',
	`targetVersion` varchar(64) NOT NULL DEFAULT '',
	`fixedInVersion` varchar(64) NOT NULL DEFAULT '',
	`reporterId` int NOT NULL,
	`handlerId` int,
	`viewState` enum('public','private') NOT NULL DEFAULT 'public',
	`sticky` boolean NOT NULL DEFAULT false,
	`dueDate` date,
	`estimate` float,
	`storyPoints` smallint,
	`created` datetime(3) NOT NULL,
	`updated` datetime(3) NOT NULL,
	`searchNorm` longtext NOT NULL,
	`tagsSorted` varchar(255) NOT NULL DEFAULT '',
	`noteCount` smallint NOT NULL DEFAULT 0,
	`attachmentCount` smallint NOT NULL DEFAULT 0,
	`historyCount` smallint NOT NULL DEFAULT 0,
	`resolvedAt` datetime(3),
	`firstResolvedAt` datetime(3),
	`reopenedAt` datetime(3),
	`reopenCount` smallint NOT NULL DEFAULT 0,
	`resolvedAtEstimated` boolean NOT NULL DEFAULT false,
	`deletedAt` datetime(3),
	`rowVersion` int NOT NULL DEFAULT 0,
	CONSTRAINT `issues_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `comments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`issueId` int NOT NULL,
	`authorId` int NOT NULL,
	`body` longtext,
	`bodyNorm` longtext NOT NULL,
	`private` boolean NOT NULL DEFAULT false,
	`timeSpent` smallint NOT NULL DEFAULT 0,
	`created` datetime(3) NOT NULL,
	`edited` datetime(3),
	`deletedAt` datetime(3),
	CONSTRAINT `comments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`documentId` int NOT NULL,
	`issueId` int,
	`commentId` int,
	`name` varchar(255) NOT NULL,
	`description` varchar(512) NOT NULL DEFAULT '',
	`mimeType` varchar(128) NOT NULL,
	`sniffedMimeType` varchar(128),
	`size` int NOT NULL,
	`uploaderId` int NOT NULL,
	`date` datetime(3) NOT NULL,
	`version` smallint NOT NULL DEFAULT 1,
	`previousVersionId` int,
	`current` boolean NOT NULL DEFAULT true,
	`blobHash` char(64) NOT NULL,
	`blobMissing` boolean NOT NULL DEFAULT false,
	`deletedAt` datetime(3),
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`hash` char(64) NOT NULL,
	`size` int NOT NULL,
	`refCount` int NOT NULL DEFAULT 0,
	`created` datetime(3) NOT NULL,
	CONSTRAINT `blobs_hash` PRIMARY KEY(`hash`)
);
--> statement-breakpoint
CREATE TABLE `historyEntries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`issueId` int NOT NULL,
	`userId` int NOT NULL,
	`date` datetime(3) NOT NULL,
	`type` enum('created','field','note_added','note_edited','note_deleted','attachment_added','attachment_deleted','attachment_renamed','attachment_version','relationship_added','relationship_deleted','tag_added','tag_removed','monitor_added','monitor_removed','cloned') NOT NULL,
	`field` varchar(32) NOT NULL DEFAULT '',
	`oldValue` varchar(255) NOT NULL DEFAULT '',
	`newValue` varchar(255) NOT NULL DEFAULT '',
	CONSTRAINT `historyEntries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`issueId` int NOT NULL,
	`actorId` int NOT NULL,
	`type` enum('assigned','mentioned','status','note','attachment') NOT NULL,
	`read` boolean NOT NULL DEFAULT false,
	`date` datetime(3) NOT NULL,
	`fromStatus` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed'),
	`toStatus` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed'),
	`commentId` int,
	`attachmentId` int,
	`subject` varchar(255) NOT NULL DEFAULT '',
	`excerpt` varchar(160),
	`excerptPrivate` boolean NOT NULL DEFAULT false,
	`text` varchar(255) NOT NULL DEFAULT '',
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `savedFilters` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`ownerId` int NOT NULL,
	`shared` boolean NOT NULL DEFAULT false,
	`projectId` int,
	`isDefault` boolean NOT NULL DEFAULT false,
	`criteria` longtext NOT NULL,
	`columns` varchar(512) NOT NULL DEFAULT '',
	`sort` varchar(255) NOT NULL DEFAULT '',
	`deletedAt` datetime(3),
	CONSTRAINT `savedFilters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workflowConfig` (
	`id` int NOT NULL DEFAULT 1,
	`resolvedStatus` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed') NOT NULL,
	`autoAssignStatus` boolean NOT NULL DEFAULT true,
	`boardColumns` varchar(128) NOT NULL,
	`revision` int NOT NULL DEFAULT 0,
	`updatedAt` datetime(3) NOT NULL,
	`updatedById` int,
	CONSTRAINT `workflowConfig_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workflowStatusColors` (
	`status` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed') NOT NULL,
	`color` varchar(16) NOT NULL,
	CONSTRAINT `workflowStatusColors_status_pk` PRIMARY KEY(`status`)
);
--> statement-breakpoint
CREATE TABLE `workflowThresholds` (
	`action` enum('view','report','update','assign','changeStatus','close','reopen','delete','move','addNote','editOthersNotes','viewPrivate','uploadFile','deleteOthersFiles','monitorOthers','manageRelationships','manageTags','manageSprints','manageProject','manageUsers','manageWorkflow','manageCustomFields') NOT NULL,
	`level` tinyint NOT NULL,
	CONSTRAINT `workflowThresholds_action_pk` PRIMARY KEY(`action`)
);
--> statement-breakpoint
CREATE TABLE `workflowTransitions` (
	`fromStatus` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed') NOT NULL,
	`toStatus` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed') NOT NULL,
	CONSTRAINT `workflowTransitions_fromStatus_toStatus_pk` PRIMARY KEY(`fromStatus`,`toStatus`)
);
--> statement-breakpoint
CREATE TABLE `workflowWipLimits` (
	`status` enum('new','feedback','acknowledged','confirmed','assigned','resolved','closed') NOT NULL,
	`limitValue` smallint NOT NULL,
	CONSTRAINT `workflowWipLimits_status_pk` PRIMARY KEY(`status`)
);
--> statement-breakpoint
CREATE TABLE `importRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`schemaVersion` int NOT NULL,
	`source` varchar(128) NOT NULL,
	`mode` varchar(16) NOT NULL,
	`startedAt` datetime(3) NOT NULL,
	`finishedAt` datetime(3),
	`counts` longtext,
	`error` varchar(1024),
	CONSTRAINT `importRuns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`topic` varchar(64) NOT NULL,
	`payload` longtext NOT NULL,
	`created` datetime(3) NOT NULL,
	`dispatchedAt` datetime(3),
	`attempts` int NOT NULL DEFAULT 0,
	`lastError` varchar(512),
	CONSTRAINT `outbox_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `undoTokens` (
	`token` char(36) NOT NULL,
	`userId` int NOT NULL,
	`operation` varchar(48) NOT NULL,
	`payload` longtext NOT NULL,
	`created` datetime(3) NOT NULL,
	`expiresAt` datetime(3) NOT NULL,
	`usedAt` datetime(3),
	CONSTRAINT `undoTokens_token` PRIMARY KEY(`token`)
);
--> statement-breakpoint
ALTER TABLE `refreshTokens` ADD CONSTRAINT `refreshTokens_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `userPrefs` ADD CONSTRAINT `userPrefs_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projectCategories` ADD CONSTRAINT `projectCategories_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projectCategories` ADD CONSTRAINT `projectCategories_defaultHandlerId_users_id_fk` FOREIGN KEY (`defaultHandlerId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projectMembers` ADD CONSTRAINT `projectMembers_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projectMembers` ADD CONSTRAINT `projectMembers_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projectVersions` ADD CONSTRAINT `projectVersions_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sprints` ADD CONSTRAINT `sprints_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projectCustomFields` ADD CONSTRAINT `projectCustomFields_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projectCustomFields` ADD CONSTRAINT `projectCustomFields_customFieldId_customFields_id_fk` FOREIGN KEY (`customFieldId`) REFERENCES `customFields`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issueCustomValues` ADD CONSTRAINT `issueCustomValues_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issueCustomValues` ADD CONSTRAINT `issueCustomValues_customFieldId_customFields_id_fk` FOREIGN KEY (`customFieldId`) REFERENCES `customFields`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issueMonitors` ADD CONSTRAINT `issueMonitors_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issueMonitors` ADD CONSTRAINT `issueMonitors_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issueRelationships` ADD CONSTRAINT `issueRelationships_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issueRelationships` ADD CONSTRAINT `issueRelationships_otherIssueId_issues_id_fk` FOREIGN KEY (`otherIssueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issueTags` ADD CONSTRAINT `issueTags_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issues` ADD CONSTRAINT `issues_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issues` ADD CONSTRAINT `issues_sprintId_sprints_id_fk` FOREIGN KEY (`sprintId`) REFERENCES `sprints`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issues` ADD CONSTRAINT `issues_reporterId_users_id_fk` FOREIGN KEY (`reporterId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `issues` ADD CONSTRAINT `issues_handlerId_users_id_fk` FOREIGN KEY (`handlerId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `comments_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `comments_authorId_users_id_fk` FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_commentId_comments_id_fk` FOREIGN KEY (`commentId`) REFERENCES `comments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_uploaderId_users_id_fk` FOREIGN KEY (`uploaderId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `historyEntries` ADD CONSTRAINT `historyEntries_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `historyEntries` ADD CONSTRAINT `historyEntries_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_issueId_issues_id_fk` FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_actorId_users_id_fk` FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_commentId_comments_id_fk` FOREIGN KEY (`commentId`) REFERENCES `comments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `savedFilters` ADD CONSTRAINT `savedFilters_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `savedFilters` ADD CONSTRAINT `savedFilters_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workflowConfig` ADD CONSTRAINT `workflowConfig_updatedById_users_id_fk` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `undoTokens` ADD CONSTRAINT `undoTokens_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_refresh_user` ON `refreshTokens` (`userId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `idx_refresh_family` ON `refreshTokens` (`family`);--> statement-breakpoint
CREATE INDEX `idx_users_enabled_level` ON `users` (`enabled`,`accessLevel`);--> statement-breakpoint
CREATE INDEX `idx_categories_order` ON `projectCategories` (`projectId`,`sortOrder`);--> statement-breakpoint
CREATE INDEX `idx_members_user` ON `projectMembers` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_versions_order` ON `projectVersions` (`projectId`,`sortOrder`);--> statement-breakpoint
CREATE INDEX `idx_projects_parent` ON `projects` (`parentId`);--> statement-breakpoint
CREATE INDEX `idx_sprints_project_state` ON `sprints` (`projectId`,`state`,`start`);--> statement-breakpoint
CREATE INDEX `idx_customvalues_field` ON `issueCustomValues` (`customFieldId`);--> statement-breakpoint
CREATE INDEX `idx_monitors_user` ON `issueMonitors` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_rel_other` ON `issueRelationships` (`otherIssueId`);--> statement-breakpoint
CREATE INDEX `idx_issuetags_tag` ON `issueTags` (`tag`);--> statement-breakpoint
CREATE INDEX `idx_issues_list` ON `issues` (`projectId`,`statusRank`,`priorityRank`);--> statement-breakpoint
CREATE INDEX `idx_issues_sprint` ON `issues` (`projectId`,`sprintId`);--> statement-breakpoint
CREATE INDEX `idx_issues_handler` ON `issues` (`handlerId`,`statusRank`);--> statement-breakpoint
CREATE INDEX `idx_issues_reporter` ON `issues` (`reporterId`,`statusRank`);--> statement-breakpoint
CREATE INDEX `idx_issues_updated` ON `issues` (`projectId`,`updated`);--> statement-breakpoint
CREATE INDEX `idx_issues_sticky` ON `issues` (`sticky`,`updated`);--> statement-breakpoint
CREATE INDEX `idx_issues_due` ON `issues` (`dueDate`,`statusRank`);--> statement-breakpoint
CREATE INDEX `idx_issues_target` ON `issues` (`projectId`,`targetVersion`);--> statement-breakpoint
CREATE INDEX `idx_issues_fixed` ON `issues` (`projectId`,`fixedInVersion`);--> statement-breakpoint
CREATE INDEX `idx_issues_category` ON `issues` (`projectId`,`category`);--> statement-breakpoint
CREATE INDEX `idx_issues_view` ON `issues` (`viewState`);--> statement-breakpoint
CREATE INDEX `idx_issues_deleted` ON `issues` (`deletedAt`);--> statement-breakpoint
CREATE INDEX `idx_comments_issue` ON `comments` (`issueId`,`created`);--> statement-breakpoint
CREATE INDEX `idx_comments_author` ON `comments` (`authorId`);--> statement-breakpoint
CREATE INDEX `idx_comments_private` ON `comments` (`issueId`,`private`);--> statement-breakpoint
CREATE INDEX `idx_comments_deleted` ON `comments` (`deletedAt`);--> statement-breakpoint
CREATE INDEX `idx_att_issue_current` ON `attachments` (`issueId`,`current`);--> statement-breakpoint
CREATE INDEX `idx_att_document` ON `attachments` (`documentId`,`version`);--> statement-breakpoint
CREATE INDEX `idx_att_comment` ON `attachments` (`commentId`);--> statement-breakpoint
CREATE INDEX `idx_att_blob` ON `attachments` (`blobHash`);--> statement-breakpoint
CREATE INDEX `idx_att_pending` ON `attachments` (`issueId`,`uploaderId`,`date`);--> statement-breakpoint
CREATE INDEX `idx_att_deleted` ON `attachments` (`deletedAt`);--> statement-breakpoint
CREATE INDEX `idx_history_issue` ON `historyEntries` (`issueId`,`date`);--> statement-breakpoint
CREATE INDEX `idx_history_field` ON `historyEntries` (`issueId`,`field`);--> statement-breakpoint
CREATE INDEX `idx_history_date` ON `historyEntries` (`date`);--> statement-breakpoint
CREATE INDEX `idx_history_user` ON `historyEntries` (`userId`,`date`);--> statement-breakpoint
CREATE INDEX `idx_notif_user` ON `notifications` (`userId`,`read`,`date`);--> statement-breakpoint
CREATE INDEX `idx_notif_issue` ON `notifications` (`issueId`);--> statement-breakpoint
CREATE INDEX `idx_filters_owner` ON `savedFilters` (`ownerId`);--> statement-breakpoint
CREATE INDEX `idx_filters_shared` ON `savedFilters` (`shared`);--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox` (`dispatchedAt`,`id`);--> statement-breakpoint
CREATE INDEX `idx_undo_expiry` ON `undoTokens` (`expiresAt`);
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written from here down. Drizzle's DSL cannot express any of it, and having
-- editable .sql migrations is a large part of why Drizzle suits this project.
-- ─────────────────────────────────────────────────────────────────────────────

-- utf8mb4_unicode_ci is insensitive to BOTH case and accents, which is what makes
-- `LIKE '%maria%'` find "María" with no extra code — the behaviour issue-filter.ts gets
-- from its norm() helper. The server default here is utf8mb4_general_ci, so the tables
-- that take part in text comparisons are converted explicitly rather than inherited.
ALTER TABLE `issues` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
ALTER TABLE `comments` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
ALTER TABLE `projects` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
ALTER TABLE `users` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
ALTER TABLE `issueTags` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
ALTER TABLE `issueCustomValues` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint

-- FULLTEXT accelerators for the text filter. They are NOT the authority on search
-- semantics: InnoDB matches whole tokens, while the frontend does a substring `includes`,
-- so SearchPort falls back to LIKE when exactness demands it (short terms, stopwords).
-- These indexes assume innodb_ft_min_token_size=1 and innodb_ft_enable_stopword=OFF are
-- already set in my.cnf — changing either afterwards requires rebuilding the indexes.
CREATE FULLTEXT INDEX `ft_issue_search` ON `issues` (`searchNorm`);
--> statement-breakpoint
CREATE FULLTEXT INDEX `ft_comment_search` ON `comments` (`bodyNorm`);
