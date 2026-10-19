import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Database Management API Routes
 * Stats, backups, vacuum, optimization
 *
 * B2.2c, PostgreSQL (AGENT_PLAYER_DB=postgres): these are SQLite admin
 * surfaces. The stats come from the PostgreSQL catalog (pg_database_size,
 * pg_stat_user_tables, pg_total_relation_size); the health check runs on the
 * process driver. Backup, vacuum and restore, and the SQLite table browser
 * (raw SQL, PRAGMA schema, row editing, clean / clear / optimize), are refused
 * with 501 { code: 'not_supported_on_postgres' }: a PostgreSQL database is
 * backed up and restored with pg_dump / pg_restore outside the app. Access
 * stays owner-only (auth gate tier 'owner' for /api/database).
 */

import type { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/index.js';
import { dbDriver } from '../../db/pg/config.js';
import { all, num, one, sql, type Step } from '../../repositories/sql-steps.js';
import { existsSync, readdirSync, statSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { dataPath, mainDatabasePath } from '../../config/data-root.js';
import { getUserIdFromRequest } from '../../auth/jwt.js';
import { validateTableName } from '../../db/sql-utils.js';
import { handleError } from '../error-handler.js';

/** A backup file name: one plain segment ending in `.db` (no paths, no `..`). */
export function isSafeBackupName(filename: unknown): filename is string {
  return typeof filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.db$/.test(filename) && !filename.includes('..');
}

/** Routes that only exist for the SQLite file (refused with 501 on PostgreSQL). */
export const SQLITE_ONLY_DATABASE_ROUTES: ReadonlySet<string> = new Set([
  '/api/database/backup',
  '/api/database/vacuum',
  '/api/database/restore',
  '/api/database/optimize',
  '/api/database/clean',
  '/api/database/clear',
  '/api/database/tables',
  '/api/database/table/:name/schema',
  '/api/database/table/:name/data',
  '/api/database/query',
  '/api/database/export',
  '/api/database/table/:name/row',
  '/api/database/table/:name/rows/delete',
  '/api/database/table/:name/rows/export',
]);

export const NOT_SUPPORTED_ON_POSTGRES = {
  error: 'Not supported on PostgreSQL: back up and restore the database with pg_dump / pg_restore outside the app',
  code: 'not_supported_on_postgres',
} as const;

interface TableStat { name: string; description: string; records: number; size: number }

function describeTable(name: string): string {
  return name
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The stats on PostgreSQL: database size and the user tables from the catalog. */
function* pgStatsStep(): Step<{ totalSize: number; totalRecords: number; tables: TableStat[]; lastModified: string }> {
  const size = yield* one<{ size: unknown }>('SELECT pg_database_size(current_database()) AS size');
  const rows = yield* all<{ name: string; size: unknown }>(`
    SELECT relname AS name, pg_total_relation_size(relid) AS size
    FROM pg_stat_user_tables
    WHERE schemaname = current_schema()
    ORDER BY relname`);
  const tables: TableStat[] = [];
  let totalRecords = 0;
  for (const r of rows) {
    // SECURITY: Validate table name before using in SQL
    const safeName = validateTableName(r.name);
    const count = yield* one<{ count: number }>(`SELECT COUNT(*) as count FROM ${safeName}`);
    const records = count?.count ?? 0;
    totalRecords += records;
    tables.push({ name: r.name, description: describeTable(r.name), records, size: num<number>(r.size) ?? 0 });
  }
  tables.sort((a, b) => b.records - a.records);
  return { totalSize: num<number>(size?.size) ?? 0, totalRecords, tables, lastModified: new Date().toISOString() };
}

export async function databaseRoutes(fastify: FastifyInstance) {
  // B2.2c: on PostgreSQL the SQLite-only surfaces answer 501 (after the
  // owner-only auth gate, which runs on onRequest).
  fastify.addHook('preHandler', async (request, reply) => {
    if (dbDriver() !== 'postgres') return;
    const route = request.routeOptions?.url;
    if (route && SQLITE_ONLY_DATABASE_ROUTES.has(route)) {
      return reply.code(501).send(NOT_SUPPORTED_ON_POSTGRES);
    }
  });

  // BUG-01: the same file the main database opens (DATABASE_PATH, else the
  // data root's agent-player.db), and backups next to the other data.
  const dbPath = resolve(mainDatabasePath());
  const backupDir = dataPath('backups');

  /**
   * GET /api/database/stats - Get database statistics
   */
  fastify.get('/api/database/stats', {
    schema: {
      tags: ['Database'],
      description: 'Get database statistics (size, tables, records)',
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication
      getUserIdFromRequest(request);

      if (dbDriver() === 'postgres') return await sql().read(pgStatsStep());

      const db = getDatabase();

      // Get database file size
      const dbStats = statSync(dbPath);
      const totalSize = dbStats.size;
      const lastModified = dbStats.mtime.toISOString();

      // Get all tables
      const tablesQuery = db.prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string; sql: string }>;

      const tables = [];
      let totalRecords = 0;

      for (const table of tablesQuery) {
        try {
          // SECURITY: Validate table name before using in SQL
          const safeName = validateTableName(table.name);

          // Get record count
          const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${safeName}`).get() as { count: number };
          const records = countResult.count;
          totalRecords += records;

          // Estimate table size (rough approximation)
          const pageCountResult = db.prepare(`SELECT * FROM dbstat WHERE name = ?`).get(table.name) as any;
          const estimatedSize = pageCountResult ? pageCountResult.pageno * 4096 : 0;

          // Generate description from table name
          const description = table.name
            .replace(/_/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

          tables.push({
            name: table.name,
            description,
            records,
            size: estimatedSize || Math.floor(totalSize / tablesQuery.length), // Fallback to average
          });
        } catch (err) {
          console.error(`Error getting stats for table ${table.name}:`, err);
        }
      }

      // Sort tables by record count (descending)
      tables.sort((a, b) => b.records - a.records);

      return {
        totalSize,
        totalRecords,
        tables,
        lastModified,
      };
    } catch (error: any) {
      console.error('[Database API] ❌ Stats failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * GET /api/database/backups - List all backups
   */
  fastify.get('/api/database/backups', {
    schema: {
      tags: ['Database'],
      description: 'List all database backups',
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication
      getUserIdFromRequest(request);

      if (!existsSync(backupDir)) {
        return { backups: [] };
      }

      const files = readdirSync(backupDir)
        .filter(f => f.endsWith('.db'))
        .map(filename => {
          const filePath = join(backupDir, filename);
          const stats = statSync(filePath);
          return {
            filename,
            size: stats.size,
            created: stats.ctime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

      return { backups: files };
    } catch (error: any) {
      console.error('[Database API] ❌ List backups failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/backup - Create a new backup
   */
  fastify.post('/api/database/backup', {
    schema: {
      tags: ['Database'],
      description: 'Create a database backup',
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication
      getUserIdFromRequest(request);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' +
                        new Date().toISOString().split('T')[1].split('.')[0].replace(/:/g, '-');
      const filename = `database_${timestamp}.db`;
      const backupPath = join(backupDir, filename);

      // Online backup through SQLite (consistent while the database is open).
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      await getDatabase().backup(backupPath);

      const stats = statSync(backupPath);

      console.log(`[Database API] ✅ Backup created: ${filename}`);

      return {
        success: true,
        backup: {
          filename,
          size: stats.size,
          created: stats.ctime.toISOString(),
        },
      };
    } catch (error: any) {
      console.error('[Database API] ❌ Backup failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * GET /api/database/backups/:filename - Download a backup
   */
  fastify.get<{ Params: { filename: string } }>('/api/database/backups/:filename', {
    schema: {
      tags: ['Database'],
      params: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication - prevents data breach
      getUserIdFromRequest(request);

      const { filename } = request.params;
      if (!isSafeBackupName(filename)) {
        return reply.status(404).send({
          error: 'Backup not found',
        });
      }
      const backupPath = join(backupDir, filename);

      if (!existsSync(backupPath)) {
        return reply.status(404).send({
          error: 'Backup not found',
        });
      }

      const fileStream = readFileSync(backupPath);
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Content-Type', 'application/octet-stream');
      return reply.send(fileStream);
    } catch (error: any) {
      console.error('[Database API] ❌ Download backup failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * DELETE /api/database/backups/:filename - Delete a backup
   */
  fastify.delete<{ Params: { filename: string } }>('/api/database/backups/:filename', {
    schema: {
      tags: ['Database'],
      params: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication
      getUserIdFromRequest(request);

      const { filename } = request.params;
      if (!isSafeBackupName(filename)) {
        return reply.status(404).send({
          error: 'Backup not found',
        });
      }
      const backupPath = join(backupDir, filename);

      if (!existsSync(backupPath)) {
        return reply.status(404).send({
          error: 'Backup not found',
        });
      }

      unlinkSync(backupPath);
      console.log(`[Database API] ✅ Backup deleted: ${filename}`);

      return {
        success: true,
        message: `Backup "${filename}" deleted`,
      };
    } catch (error: any) {
      console.error('[Database API] ❌ Delete backup failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/vacuum - Run VACUUM command
   */
  fastify.post('/api/database/vacuum', {
    schema: {
      tags: ['Database'],
      description: 'Compact database and reclaim space',
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication
      getUserIdFromRequest(request);

      const db = getDatabase();

      const sizeBefore = statSync(dbPath).size;
      db.exec('VACUUM');
      const sizeAfter = statSync(dbPath).size;
      const savedSpace = sizeBefore - sizeAfter;

      console.log(`[Database API] ✅ VACUUM completed: saved ${savedSpace} bytes`);

      return {
        success: true,
        sizeBefore,
        sizeAfter,
        savedSpace,
      };
    } catch (error: any) {
      console.error('[Database API] ❌ VACUUM failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/restore - Restore from backup
   */
  fastify.post<{ Body: { filename: string } }>('/api/database/restore', {
    schema: {
      tags: ['Database'],
      description: 'Restore database from backup file',
      body: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
        },
        required: ['filename'],
      },
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication - critical destructive operation
      getUserIdFromRequest(request);

      const { filename } = request.body;
      if (!isSafeBackupName(filename) || !existsSync(join(backupDir, filename))) {
        return reply.status(404).send({
          error: 'Backup not found',
        });
      }

      // BUG-01: this route used to copy over a file the server never opened
      // (`.data/database.db`). Now that it would hit the live database,
      // overwriting the open SQLite file (and its WAL) in place could corrupt
      // it, so an online restore is refused. Stop the server and copy the
      // backup over the database file instead.
      return reply.status(409).send({
        error: 'Restore needs the server stopped: stop it, then copy the backup file over the database file',
        code: 'restore_offline_only',
      });
    } catch (error: any) {
      console.error('[Database API] ❌ Restore failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/optimize - Run ANALYZE command
   */
  fastify.post('/api/database/optimize', {
    schema: {
      tags: ['Database'],
      description: 'Analyze and optimize database performance',
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication
      getUserIdFromRequest(request);

      const db = getDatabase();

      // Run ANALYZE to update query planner statistics
      db.exec('ANALYZE');

      // Get all tables
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;

      console.log(`[Database API] ✅ ANALYZE completed for ${tables.length} tables`);

      return {
        success: true,
        tablesAnalyzed: tables.length,
        message: 'Database optimized successfully',
      };
    } catch (error: any) {
      console.error('[Database API] ❌ Optimize failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/clean - Clean old records
   */
  fastify.post<{ Body: { daysOld?: number } }>('/api/database/clean', {
    schema: {
      tags: ['Database'],
      description: 'Remove records older than specified days',
      body: {
        type: 'object',
        properties: {
          daysOld: { type: 'number', default: 90 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication
      getUserIdFromRequest(request);

      const db = getDatabase();
      const daysOld = request.body?.daysOld || 90;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      const cutoffISO = cutoffDate.toISOString();

      let deletedCount = 0;

      // Clean chat_messages
      const chatMsgs = db.prepare('DELETE FROM chat_messages WHERE created_at < ?').run(cutoffISO);
      deletedCount += chatMsgs.changes;

      // Clean agent_activity
      const activity = db.prepare('DELETE FROM agent_activity WHERE timestamp < ?').run(cutoffISO);
      deletedCount += activity.changes;

      // Clean storage_files (cache only)
      const storage = db.prepare('DELETE FROM storage_files WHERE zone = ? AND created_at < ?').run('cache', cutoffISO);
      deletedCount += storage.changes;

      // Clean waf_scans if table exists
      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='waf_scans'
      `).get();
      if (tableExists) {
        const wafScans = db.prepare('DELETE FROM waf_scans WHERE created_at < ?').run(cutoffISO);
        deletedCount += wafScans.changes;
      }

      safeConsole.log(`[Database API] ✅ Cleaned ${deletedCount} old records (>${daysOld} days)`);

      return {
        success: true,
        deletedCount,
        daysOld,
        message: `Removed ${deletedCount} records older than ${daysOld} days`,
      };
    } catch (error: any) {
      console.error('[Database API] ❌ Clean failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/clear - Clear all data (danger zone)
   */
  fastify.post('/api/database/clear', {
    schema: {
      tags: ['Database'],
      description: 'Delete all records from database (keeps structure)',
    },
  }, async (request, reply) => {
    try {
      // SECURITY: Require authentication - CRITICAL destructive operation
      getUserIdFromRequest(request);

      const db = getDatabase();

      // Get all tables except migrations and users
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT IN ('migrations', 'users', 'agents_config')
      `).all() as Array<{ name: string }>;

      let totalDeleted = 0;

      for (const table of tables) {
        try {
          // SECURITY: Validate table name before using in SQL
          const safeName = validateTableName(table.name);
          const result = db.prepare(`DELETE FROM ${safeName}`).run();
          totalDeleted += result.changes;
        } catch (err) {
          console.error(`Error clearing table ${table.name}:`, err);
        }
      }

      // Run VACUUM to reclaim space
      db.exec('VACUUM');

      console.log(`[Database API] ⚠️ CLEAR ALL: ${totalDeleted} records deleted from ${tables.length} tables`);

      return {
        success: true,
        deletedCount: totalDeleted,
        tablesCleared: tables.length,
        message: `Cleared ${totalDeleted} records from ${tables.length} tables`,
      };
    } catch (error: any) {
      console.error('[Database API] ❌ Clear all failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * GET /api/database/tables - Get all tables with full details
   */
  fastify.get('/api/database/tables', {
    schema: {
      tags: ['Database'],
      description: 'Get all database tables with full details',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const db = getDatabase();

      const tablesQuery = db.prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string; sql: string }>;

      const tables = [];
      for (const table of tablesQuery) {
        try {
          const safeName = validateTableName(table.name);
          const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${safeName}`).get() as { count: number };

          tables.push({
            name: table.name,
            rows: countResult.count,
            sql: table.sql,
          });
        } catch (err) {
          console.error(`Error getting table ${table.name}:`, err);
        }
      }

      return { tables };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * GET /api/database/table/:name/schema - Get table structure
   */
  fastify.get<{ Params: { name: string } }>('/api/database/table/:name/schema', {
    schema: {
      tags: ['Database'],
      description: 'Get table schema (columns, indexes, foreign keys)',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { name } = request.params;
      const safeName = validateTableName(name);
      const db = getDatabase();

      // Get columns
      const columns = db.prepare(`PRAGMA table_info(${safeName})`).all();

      // Get indexes
      const indexes = db.prepare(`PRAGMA index_list(${safeName})`).all();
      const indexDetails = indexes.map((idx: any) => {
        const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all();
        return { ...idx, columns: cols };
      });

      // Get foreign keys
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${safeName})`).all();

      // Get table SQL
      const tableInfo = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type='table' AND name = ?
      `).get(name) as { sql: string };

      return {
        table: name,
        columns,
        indexes: indexDetails,
        foreignKeys,
        sql: tableInfo?.sql || '',
      };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * GET /api/database/table/:name/data - Get table data with pagination
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { page?: string; limit?: string; search?: string };
  }>('/api/database/table/:name/data', {
    schema: {
      tags: ['Database'],
      description: 'Get table data with pagination',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { name } = request.params;
      const page = parseInt(request.query.page || '1');
      const limit = parseInt(request.query.limit || '50');
      const search = request.query.search || '';
      const offset = (page - 1) * limit;

      const safeName = validateTableName(name);
      const db = getDatabase();

      // Get total count
      const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${safeName}`).get() as { count: number };
      const total = countResult.count;

      // Get data with pagination
      let query = `SELECT * FROM ${safeName}`;
      if (search) {
        query += ` WHERE ${safeName} LIKE '%${search}%'`;
      }
      query += ` LIMIT ${limit} OFFSET ${offset}`;

      const rows = db.prepare(query).all();

      return {
        table: name,
        data: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/query - Execute SQL query
   */
  fastify.post<{ Body: { query: string; mode?: 'read' | 'write' } }>('/api/database/query', {
    schema: {
      tags: ['Database'],
      description: 'Execute SQL query (read or write)',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { query, mode = 'read' } = request.body;

      if (!query || query.trim() === '') {
        return reply.code(400).send({ error: 'Query is required' });
      }

      const db = getDatabase();
      const trimmedQuery = query.trim().toUpperCase();

      // Security check: prevent dangerous operations
      const dangerousKeywords = ['DROP TABLE', 'DROP DATABASE', 'TRUNCATE'];
      if (dangerousKeywords.some(keyword => trimmedQuery.includes(keyword))) {
        return reply.code(403).send({ error: 'Dangerous query not allowed' });
      }

      try {
        let result;
        if (mode === 'write' || trimmedQuery.startsWith('INSERT') ||
            trimmedQuery.startsWith('UPDATE') || trimmedQuery.startsWith('DELETE')) {
          const stmt = db.prepare(query);
          result = stmt.run();
          return {
            success: true,
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
            mode: 'write',
          };
        } else {
          result = db.prepare(query).all();
          return {
            success: true,
            rows: result,
            count: result.length,
            mode: 'read',
          };
        }
      } catch (sqlError: any) {
        return reply.code(400).send({
          error: 'SQL Error',
          message: sqlError.message,
        });
      }
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/export - Export table data
   */
  fastify.post<{ Body: { table: string; format: 'sql' | 'csv' | 'json' } }>('/api/database/export', {
    schema: {
      tags: ['Database'],
      description: 'Export table data in SQL/CSV/JSON format',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { table, format } = request.body;
      const safeName = validateTableName(table);
      const db = getDatabase();

      const rows = db.prepare(`SELECT * FROM ${safeName}`).all() as Record<string, unknown>[];

      if (format === 'json') {
        reply.header('Content-Type', 'application/json');
        reply.header('Content-Disposition', `attachment; filename="${table}.json"`);
        return rows;
      } else if (format === 'csv') {
        if (rows.length === 0) {
          return reply.code(400).send({ error: 'No data to export' });
        }

        const keys = Object.keys(rows[0]);
        const csv = [
          keys.join(','),
          ...rows.map(row => keys.map(k => JSON.stringify((row as any)[k])).join(','))
        ].join('\n');

        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${table}.csv"`);
        return csv;
      } else if (format === 'sql') {
        const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table) as { sql: string };
        let sql = schema.sql + ';\n\n';

        if (rows.length > 0) {
          const keys = Object.keys(rows[0]);
          sql += rows.map(row => {
            const values = keys.map(k => {
              const val = (row as any)[k];
              return val === null ? 'NULL' : typeof val === 'string' ? `'${val.replace(/'/g, "''")}'` : val;
            }).join(', ');
            return `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${values});`;
          }).join('\n');
        }

        reply.header('Content-Type', 'text/plain');
        reply.header('Content-Disposition', `attachment; filename="${table}.sql"`);
        return sql;
      }

      return reply.code(400).send({ error: 'Invalid format' });
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * DELETE /api/database/table/:name/row - Delete a single row
   */
  fastify.delete<{ Params: { name: string }; Body: { primaryKey: string; primaryValue: any } }>('/api/database/table/:name/row', {
    schema: {
      tags: ['Database'],
      description: 'Delete a single row by primary key',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { name } = request.params;
      const { primaryKey, primaryValue } = request.body;
      const safeName = validateTableName(name);
      const db = getDatabase();

      const stmt = db.prepare(`DELETE FROM ${safeName} WHERE ${primaryKey} = ?`);
      const result = stmt.run(primaryValue);

      return {
        success: true,
        changes: result.changes,
      };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * PUT /api/database/table/:name/row - Update a single row
   */
  fastify.put<{ Params: { name: string }; Body: { primaryKey: string; primaryValue: any; data: Record<string, any> } }>('/api/database/table/:name/row', {
    schema: {
      tags: ['Database'],
      description: 'Update a single row by primary key',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { name } = request.params;
      const { primaryKey, primaryValue, data } = request.body;
      const safeName = validateTableName(name);
      const db = getDatabase();

      // Build SET clause
      const columns = Object.keys(data);
      const setClause = columns.map(col => `${col} = ?`).join(', ');
      const values = columns.map(col => data[col]);

      const stmt = db.prepare(`UPDATE ${safeName} SET ${setClause} WHERE ${primaryKey} = ?`);
      const result = stmt.run(...values, primaryValue);

      return {
        success: true,
        changes: result.changes,
      };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/table/:name/row - Insert a new row
   */
  fastify.post<{ Params: { name: string }; Body: { data: Record<string, any> } }>('/api/database/table/:name/row', {
    schema: {
      tags: ['Database'],
      description: 'Insert a new row',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { name } = request.params;
      const { data } = request.body;
      const safeName = validateTableName(name);
      const db = getDatabase();

      const columns = Object.keys(data);
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(col => data[col]);

      const stmt = db.prepare(`INSERT INTO ${safeName} (${columns.join(', ')}) VALUES (${placeholders})`);
      const result = stmt.run(...values);

      return {
        success: true,
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/table/:name/rows/delete - Bulk delete rows
   */
  fastify.post<{ Params: { name: string }; Body: { primaryKey: string; ids: any[] } }>('/api/database/table/:name/rows/delete', {
    schema: {
      tags: ['Database'],
      description: 'Delete multiple rows by primary keys',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { name } = request.params;
      const { primaryKey, ids } = request.body;
      const safeName = validateTableName(name);
      const db = getDatabase();

      const placeholders = ids.map(() => '?').join(', ');
      const stmt = db.prepare(`DELETE FROM ${safeName} WHERE ${primaryKey} IN (${placeholders})`);
      const result = stmt.run(...ids);

      return {
        success: true,
        changes: result.changes,
      };
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  /**
   * POST /api/database/table/:name/rows/export - Export selected rows
   */
  fastify.post<{ Params: { name: string }; Body: { primaryKey: string; ids: any[]; format: 'sql' | 'csv' | 'json' } }>('/api/database/table/:name/rows/export', {
    schema: {
      tags: ['Database'],
      description: 'Export selected rows in SQL/CSV/JSON format',
    },
  }, async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { name } = request.params;
      const { primaryKey, ids, format } = request.body;
      const safeName = validateTableName(name);
      const db = getDatabase();

      const placeholders = ids.map(() => '?').join(', ');
      const rows = db.prepare(`SELECT * FROM ${safeName} WHERE ${primaryKey} IN (${placeholders})`).all(...ids) as Record<string, unknown>[];

      if (format === 'json') {
        reply.header('Content-Type', 'application/json');
        reply.header('Content-Disposition', `attachment; filename="${name}_selected.json"`);
        return rows;
      } else if (format === 'csv') {
        if (rows.length === 0) {
          return reply.code(400).send({ error: 'No data to export' });
        }

        const keys = Object.keys(rows[0]);
        const csv = [
          keys.join(','),
          ...rows.map(row => keys.map(k => JSON.stringify((row as any)[k])).join(','))
        ].join('\n');

        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${name}_selected.csv"`);
        return csv;
      } else if (format === 'sql') {
        if (rows.length === 0) {
          return reply.code(400).send({ error: 'No data to export' });
        }

        let sql = '';
        const keys = Object.keys(rows[0]);
        sql += rows.map(row => {
          const values = keys.map(k => {
            const val = (row as any)[k];
            return val === null ? 'NULL' : typeof val === 'string' ? `'${val.replace(/'/g, "''")}'` : val;
          }).join(', ');
          return `INSERT INTO ${name} (${keys.join(', ')}) VALUES (${values});`;
        }).join('\n');

        reply.header('Content-Type', 'text/plain');
        reply.header('Content-Disposition', `attachment; filename="${name}_selected.sql"`);
        return sql;
      }

      return reply.code(400).send({ error: 'Invalid format' });
    } catch (error: any) {
      return handleError(reply, error, 'internal', '[Database]');
    }
  });

  console.log('[Database API] ✅ Routes registered (including browser endpoints)');
}
