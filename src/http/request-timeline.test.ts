import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createApp } from '../server/app.js';
import { issueSession } from '../auth/session.js';
import { createRequest } from '../services/request.service.js';

const SECRET = 'timeline-test-secret-long-enough';

async function systemRole(db: any, code: string) {
  const [role] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return role;
}

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'Timeline holding' }).returning();
  const [workflow] = await db
    .insert(schema.workflows)
    .values({ holdingId: holding.id, name: 'Timeline workflow', isActive: true })
    .returning();
  const roles = {
    requester: await systemRole(db, 'requester'),
    deptHead: await systemRole(db, 'dept_head'),
    procurement: await systemRole(db, 'procurement'),
    engineer: await systemRole(db, 'deputy_director'),
    warehouse: await systemRole(db, 'warehouse'),
  };
  const steps = await db
    .insert(schema.workflowSteps)
    .values([
      { workflowId: workflow.id, stepOrder: 1, stepName: 'Руководитель отдела', stepKind: 'approval', approverRoleId: roles.deptHead.id },
      { workflowId: workflow.id, stepOrder: 2, stepName: 'Снабженец — процесс поиска', stepKind: 'procurement', approverRoleId: roles.procurement.id },
      { workflowId: workflow.id, stepOrder: 3, stepName: 'Главный инженер', stepKind: 'approval', approverRoleId: roles.engineer.id },
      { workflowId: workflow.id, stepOrder: 4, stepName: 'Склад — приёмка', stepKind: 'receiving', approverRoleId: roles.warehouse.id },
    ])
    .returning();

  const addUser = async (fullName: string, telegramId: string, roleId: string) => {
    const [user] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName, telegramId, status: 'active' })
      .returning();
    await db.insert(schema.userRoles).values({ userId: user.id, roleId, holdingId: holding.id });
    return user;
  };

  return {
    db,
    holding,
    workflow,
    steps,
    roles,
    addUser,
    app: createApp({ db, botToken: 'test:token', sessionSecret: SECRET }),
  };
}

describe('request workflow timeline', () => {
  it('shows the assistant as creator while preserving the selected requester', async () => {
    const { db, holding, roles, addUser, app } = await setup();
    const assistant = await addUser('Ассистент Алиса', 'timeline-assistant', roles.requester.id);
    const selectedRequester = await addUser('Руководитель Боб', 'timeline-selected-head', roles.deptHead.id);
    const row = await createRequest(db, {
      holdingId: holding.id,
      requesterId: selectedRequester.id,
      creatorId: assistant.id,
      items: [{ name: 'Материал', quantity: 1, unitPrice: 100 }],
    });

    const detail = await request(app)
      .get(`/api/requests/${row.id}`)
      .set('Authorization', `Bearer ${issueSession(assistant.id, SECRET)}`)
      .expect(200);

    expect(detail.body.requesterName).toBe('Руководитель Боб');
    expect(detail.body.workflowTimeline[0]).toMatchObject({
      stepName: 'Создание заявки',
      actorName: 'Ассистент Алиса',
      actorRole: 'Assistant',
    });
  });

  it('shows the actual business role of the user who created the request', async () => {
    const { db, holding, workflow, steps, roles, addUser, app } = await setup();
    const creator = await addUser('Начальник отдела', 'timeline-head', roles.deptHead.id);
    const [row] = await db
      .insert(schema.requests)
      .values({
        requestNumber: 'TL-001',
        holdingId: holding.id,
        requesterId: creator.id,
        workflowId: workflow.id,
        currentStepId: steps[0].id,
        status: 'pending_approval',
      })
      .returning();

    const detail = await request(app)
      .get(`/api/requests/${row.id}`)
      .set('Authorization', `Bearer ${issueSession(creator.id, SECRET)}`)
      .expect(200);

    expect(detail.body.workflowTimeline[0]).toMatchObject({
      stepName: 'Создание заявки',
      actorName: 'Начальник отдела',
      actorRole: 'Руководитель отдела',
    });
  });

  it('shows actor/time on completed stages and keeps the revision comment on the exact approval stage', async () => {
    const { db, holding, workflow, steps, roles, addUser, app } = await setup();
    const creator = await addUser('Автор', 'timeline-author', roles.requester.id);
    const head = await addUser('Иван Руководитель', 'timeline-approver', roles.deptHead.id);
    const procurement = await addUser('Олег Снабженец', 'timeline-procurement', roles.procurement.id);
    const engineer = await addUser('Азиз Инженер', 'timeline-engineer', roles.engineer.id);
    const approvedAt = new Date('2026-07-17T08:15:00.000Z');
    const searchedAt = new Date('2026-07-17T09:30:00.000Z');
    const returnedAt = new Date('2026-07-17T10:45:00.000Z');
    const comment = 'Уточните количество и приложите спецификацию';
    const [row] = await db
      .insert(schema.requests)
      .values({
        requestNumber: 'TL-002',
        holdingId: holding.id,
        requesterId: creator.id,
        workflowId: workflow.id,
        currentStepId: null,
        status: 'needs_revision',
      })
      .returning();
    await db.insert(schema.approvals).values([
      {
        requestId: row.id,
        workflowStepId: steps[0].id,
        status: 'approved',
        approverUserId: head.id,
        approvedAt,
      },
      {
        requestId: row.id,
        workflowStepId: steps[2].id,
        status: 'cancelled',
        approverUserId: engineer.id,
        comment,
        approvedAt: returnedAt,
      },
    ]);
    await db.insert(schema.requestStatusHistory).values([
      {
        requestId: row.id,
        oldStatus: 'pending_approval',
        newStatus: 'procurement',
        changedBy: head.id,
        createdAt: approvedAt,
        source: 'lifecycle',
      },
      {
        requestId: row.id,
        oldStatus: 'procurement',
        newStatus: 'pending_approval',
        changedBy: procurement.id,
        createdAt: searchedAt,
        source: 'lifecycle',
      },
      {
        requestId: row.id,
        oldStatus: 'pending_approval',
        newStatus: 'needs_revision',
        changedBy: engineer.id,
        comment,
        createdAt: returnedAt,
        source: 'lifecycle',
      },
    ]);

    const detail = await request(app)
      .get(`/api/requests/${row.id}`)
      .set('Authorization', `Bearer ${issueSession(creator.id, SECRET)}`)
      .expect(200);
    const timeline = detail.body.workflowTimeline as any[];

    expect(timeline.find((s) => s.stepId === steps[0].id)).toMatchObject({
      state: 'completed',
      actorName: 'Иван Руководитель',
      actorRole: 'Руководитель отдела',
      at: approvedAt.toISOString(),
    });
    expect(timeline.find((s) => s.stepId === steps[1].id)).toMatchObject({
      state: 'completed',
      actorName: 'Олег Снабженец',
      at: searchedAt.toISOString(),
    });
    expect(timeline.find((s) => s.stepId === steps[2].id)).toMatchObject({
      state: 'returned',
      actorName: 'Азиз Инженер',
      actorRole: 'Главный инженер',
      at: returnedAt.toISOString(),
      comment,
    });
    expect(timeline.find((s) => s.stepId === steps[3].id)).toMatchObject({ state: 'future' });
  });
});
