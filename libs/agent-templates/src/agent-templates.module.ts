import { Module } from '@nestjs/common';
import { TemplateRepoService } from './template-repo.service';

/**
 * AgentTemplatesModule (feature 030) — provides the role-template resolution
 * service consumed by the callback read endpoints and the workspace-setup
 * handoff. US1 serves built-in defaults with no external dependencies.
 */
@Module({
  providers: [TemplateRepoService],
  exports: [TemplateRepoService],
})
export class AgentTemplatesModule {}
