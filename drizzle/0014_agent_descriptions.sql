-- The agent directory: each standing agent's description in the directory template
-- (Owns / Ask for / Not for), written by the agent itself (modify_agent_prompt,
-- hath_spawn_agent) and listed in every agent's system so agents know who to ask for
-- what. Seeded for the agents active on 2026-10-16 from their charters; an id no
-- longer present updates nothing.

ALTER TABLE "agents" ADD COLUMN "description" text;
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Every browser and browser worker.\nAsk for: a one-shot browser worker that reaches a site or account you name ("a worker signed in to D2L"); bringing a dedicated browser back.\nNot for: doing the web task itself: you give your worker its steps.' WHERE "id" = 'browser-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s career direction and the career portfolio agents (applications, networking, resumes, recruiters, past roles).\nAsk for: whether a role fits him, career decisions, a new portfolio agent or a change to one''s charter.\nNot for: a resume (resume-specialist), an application (application-manager), outreach (networking-specialist).' WHERE "id" = 'career-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Every terminal and coding worker, and where their files live.\nAsk for: a coding worker with a workspace in the repo or folder you name ("a worker in ~/projects/wizviz"); download approval.\nNot for: writing code or running the task: you give your worker its steps.' WHERE "id" = 'coding-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s academic trajectory: degree requirements, GPA, credits, records, program decisions; parent of the course specialists.\nAsk for: degree audits, credit counts, transcript requests, which course to take next.\nNot for: one class''s work or deadlines (that course''s specialist).' WHERE "id" = 'education-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s time: schedules, routines, the weekly setup and the daily inbox triage across his Gmail and MSU email.\nAsk for: fitting something into his week, what is in his inbox, a new routine.\nNot for: the day-by-day Structured plan itself (schedule-specialist).' WHERE "id" = 'efficiency-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s money picture: recurring spending, commitments, budgets.\nAsk for: what a subscription or purchase really costs, whether he is on budget, the effect of a money decision.\nNot for: moving money or paying anything.' WHERE "id" = 'finance-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s physical and mental health, fitness and gym routines, medical history.\nAsk for: a health question, his medications or conditions, a gym plan, finding a clinic or appointment.' WHERE "id" = 'health-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: The owners of Ankur''s personal projects (Chello, dadi-os, fliks.gg, WizViz).\nAsk for: a question across all his projects, a new project owner.\nNot for: work on one project (that project''s owner); internships, research and clubs (career-manager).' WHERE "id" = 'project-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s ID renewal for his 21st birthday.\nAsk for: where the renewal stands, what ID.me needs.' WHERE "id" = 'thread-id-update';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Seeding Ankur''s family, birthdays, preferences and travel plans into memory.\nAsk for: what was seeded and what is still missing.' WHERE "id" = 'thread-memory-seeding';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s application to the posting from Manisha''s referral, research to submission.\nAsk for: where that application stands, its files.\nNot for: any other posting (application-manager spawns one agent per posting).' WHERE "id" = 'application-bot-manisha-referral';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Application agents, one per job posting.\nAsk for: an application agent for a posting, naming the company and role; retiring one when its application is over.\nNot for: working an application or deciding whether to apply (career-manager).' WHERE "id" = 'application-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: The record of Ankur''s Claude Builder Club @ MSU role (Co-Founder & VP, Sep 2025 to Aug 2026) and its members-portal repo.\nAsk for: detail on what he built and led there, for a resume or an interview.\nNot for: writing the resume (resume-specialist).' WHERE "id" = 'claude-msu-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: The record of Ankur''s MindMosaic software engineering internship (Jun to Dec 2025).\nAsk for: detail on what he did there, for a resume or an interview.\nNot for: writing the resume (resume-specialist).' WHERE "id" = 'mindmosaic-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s LinkedIn outreach to MSU alumni for referrals: sourcing, invites, the tracker, reply drafts.\nAsk for: who he has reached at a company, adding a contact to the next batch, a draft reply to someone who answered.' WHERE "id" = 'networking-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Research on the recruiter and company behind each job posting, written as one persona.md per posting.\nAsk for: the persona for a posting, what is known about a company he applies to.\nNot for: writing the resume (resume-specialist).' WHERE "id" = 'recruiter-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Every resume Ankur sends and the record of everything he has done (context.md).\nAsk for: a resume for a posting (with its persona.md), a bullet rewritten, a fact about his experience.\nNot for: company research (recruiter-specialist), applying (the posting''s application agent).' WHERE "id" = 'resume-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: The record of Ankur''s Robostangs FRC Team 548 captaincy (2023-24) and the Crescendo robot code.\nAsk for: detail on what he built and led there, for a resume or an interview.\nNot for: writing the resume (resume-specialist).' WHERE "id" = 'robostangs-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: The record of Ankur''s research in Prof. Bopardikar''s SEAS lab (June 2026 onward).\nAsk for: detail on his research, lab ideas, papers he has read for it.\nNot for: writing the resume (resume-specialist).' WHERE "id" = 'seas-research-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: The record of Ankur''s WFS Consulting Group web development internship (summer 2024) and its marketing-page repo.\nAsk for: detail on what he built there, for a resume or an interview.\nNot for: writing the resume (resume-specialist).' WHERE "id" = 'wfs-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: CSE 300 (Social, Ethical and Professional Issues in Computing, Fall 2026): deadlines, grading, policies, coursework.\nAsk for: what is due, a grade, doing or submitting an assignment.\nNot for: other classes (their specialists), degree questions (education-specialist).' WHERE "id" = 'cse-300-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: CSE 335 (Object-oriented Software Development, Fall 2026): deadlines, grading, policies, coursework.\nAsk for: what is due, a grade, doing or submitting a step or design.\nNot for: other classes (their specialists), degree questions (education-specialist).' WHERE "id" = 'cse-335-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: CSE 380 (Information Management and the Cloud, Fall 2026): deadlines, grading, policies, coursework.\nAsk for: what is due, a grade, doing or submitting an assignment.\nNot for: other classes (their specialists), degree questions (education-specialist).' WHERE "id" = 'cse-380-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: CSE 431 (Algorithm Engineering, Fall 2026): deadlines, grading, policies, coursework.\nAsk for: what is due, a Gradescope grade, doing or submitting homework.\nNot for: other classes (their specialists), degree questions (education-specialist).' WHERE "id" = 'cse-431-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: IAH 241 (Music and Society in the Modern World, Fall 2026): deadlines, grading, policies, coursework.\nAsk for: what is due, a grade, doing or submitting an assignment.\nNot for: other classes (their specialists), degree questions (education-specialist).' WHERE "id" = 'iah-241-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: IBIO 150 (Integrating Biology, Fall 2026): deadlines, grading, policies, coursework.\nAsk for: what is due, a grade, doing or submitting a worksheet or Codon assignment.\nNot for: other classes (their specialists), degree questions (education-specialist).' WHERE "id" = 'ibio-150-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s day-by-day plan in Structured, built from the week''s facts efficiency-specialist sends.\nAsk for: what is on a given day, putting a fixed event into the plan.\nNot for: deciding what his week should hold (efficiency-specialist).' WHERE "id" = 'schedule-specialist';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s Chello project and its chello-app repos.\nAsk for: the state of Chello, a change to it, what it does and how it differs.' WHERE "id" = 'chello-project-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: The dadi-os project: the repos of this agent system (hath, dwar, yaad, nas, thaali and the rest), as their maintainer for Ankur.\nAsk for: how part of Dadi works, a change or fix to its repos, facts about it for a resume.' WHERE "id" = 'dadi-project-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s fliks.gg project (multi-game skill certification) and its fliks-gg repos.\nAsk for: the state of fliks.gg, a change to it, facts about it for a resume.' WHERE "id" = 'fliks-gg-project-manager';
--> statement-breakpoint
UPDATE "agents" SET "description" = E'Owns: Ankur''s WizViz project and its repo.\nAsk for: the state of WizViz, a change to it, facts about it for a resume.' WHERE "id" = 'wizviz-project-manager';
