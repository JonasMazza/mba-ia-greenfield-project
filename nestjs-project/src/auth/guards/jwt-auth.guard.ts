import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user: unknown }>();
    const authHeader = request.headers?.authorization;
    const hasBearer = Boolean(authHeader?.startsWith(BEARER_PREFIX));

    // A public route still identifies the caller when a valid token comes
    // along: routes like public playback answer differently for the owner.
    // An absent or bad token is simply an anonymous request, never a 401.
    if (isPublic && !hasBearer) return true;

    if (!hasBearer) {
      throw new UnauthorizedException();
    }

    const token = authHeader.slice(BEARER_PREFIX.length);

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = payload;
      return true;
    } catch {
      if (isPublic) return true;
      throw new UnauthorizedException();
    }
  }
}
