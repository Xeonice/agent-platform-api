import { PayloadTooLargeException } from '@nestjs/common';
import { json, type RequestHandler } from 'express';

export const INTERNAL_UPGRADE_JSON_LIMIT = 24 * 1024 * 1024;

/** Preserve complete private upgrade receipts without enlarging public bodies. */
export function internalUpgradeJson(): RequestHandler {
  const parser = json({ limit: INTERNAL_UPGRADE_JSON_LIMIT });
  // Nest detects existing parsers by middleware function name. Do not register
  // the scoped parser as `jsonParser`: that would suppress its public default.
  return function internalUpgradeJsonParser(req, res, next) {
    parser(req, res, (error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'type' in error &&
        error.type === 'entity.too.large'
      ) {
        next(new PayloadTooLargeException());
        return;
      }
      next(error);
    });
  };
}
