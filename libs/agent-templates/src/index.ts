export {
  resolveTemplateSource,
  capTemplates,
  type TemplateCatalog,
} from './template-source.resolver';
export {
  TemplateRepoService,
  RoleTemplateNotFoundError,
  toSummary,
  type TemplateListResult,
} from './template-repo.service';
export { AgentTemplatesModule } from './agent-templates.module';
export { execGit, ensureCachedClone, GitError } from './clone-cache';
export { gitAuthEnv } from './git-auth';
export { parseTemplateFile } from './frontmatter';
