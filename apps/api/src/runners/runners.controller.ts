import {
  CreatePairingTokenRequest,
  type PairingTokenResponse,
  type Runner,
  UpdateRunnerRequest,
  Uuid,
} from '@coffe/contracts';
import { CLOSE_CODES } from '@coffe/protocol';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { RunnerHub } from './runner-hub.js';
import { RunnerRegistry } from './runner-registry.js';

@Controller('workspaces/:ws')
@UseGuards(WorkspaceGuard)
export class RunnersController {
  constructor(
    private readonly registry: RunnerRegistry,
    private readonly hub: RunnerHub,
  ) {}

  @Post('runner-pairing-tokens')
  @RequirePermission({ runner: ['pair'] })
  @Audit('runner.pairing_token.created', 'runner_pairing_token')
  createPairingToken(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    // A bodiless POST is a token without a label.
    @Body({ schema: CreatePairingTokenRequest.default({}) }) body: CreatePairingTokenRequest,
  ): Promise<PairingTokenResponse> {
    return this.registry.createPairingToken(workspace.id, user.id, body.label);
  }

  @Get('runners')
  list(@CurrentWorkspace() workspace: WorkspaceContext): Promise<Runner[]> {
    return this.registry.list(workspace.id);
  }

  @Get('runners/:runnerId')
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('runnerId', { schema: Uuid }) runnerId: string,
  ): Promise<Runner> {
    return this.registry.get(workspace.id, runnerId);
  }

  @Patch('runners/:runnerId')
  @RequirePermission({ runner: ['update'] })
  @Audit('runner.updated', 'runner', 'runnerId')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('runnerId', { schema: Uuid }) runnerId: string,
    @Body({ schema: UpdateRunnerRequest }) body: UpdateRunnerRequest,
  ): Promise<Runner> {
    return this.registry.update(workspace.id, runnerId, body);
  }

  /** The token stops working at once: the live socket is closed with 4001 (architecture §8.6). */
  @Post('runners/:runnerId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission({ runner: ['revoke'] })
  @Audit('runner.revoked', 'runner', 'runnerId')
  async revoke(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('runnerId', { schema: Uuid }) runnerId: string,
  ): Promise<Runner> {
    const runner = await this.registry.revoke(workspace.id, runnerId);
    this.hub.disconnect(runnerId, CLOSE_CODES.UNAUTHORIZED, 'revoked');
    await this.registry.publishStatus(runnerId);
    return runner;
  }

  /** Asks the runner to detect its CLIs again; the result arrives as `clis.updated`. */
  @Post('runners/:runnerId/detect-clis')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission({ runner: ['update'] })
  async detectClis(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('runnerId', { schema: Uuid }) runnerId: string,
  ): Promise<void> {
    await this.registry.get(workspace.id, runnerId);
    await this.hub.send(runnerId, { type: 'clis.detect', payload: {} }, { actorUserId: user.id });
  }
}
