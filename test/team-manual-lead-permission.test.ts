import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/dashboard/team/actions', () => ({ saveTeamLeadRouting: vi.fn() }));
import { TeamLeadRouting } from '@/components/team-lead-routing';
const userId='00000000-0000-0000-0000-000000000001';
function render(manualTake?: boolean) { return renderToStaticMarkup(createElement(TeamLeadRouting, { orgId:'org', installed:true, initial:{enabled:false,freshHours:24,revision:7,assignments:[{userId,blocks:['recuperacion'],backup:false,manualTake}]}, advisors:[{userId,name:'Advisor',account:'test',stores:['store']}], stores:[{id:'store',name:'Store'}] })); }
describe('individual manual-take control',()=>{
 it('shows the permission separately on desktop and mobile, off for legacy assignments',()=>{
 const html=render(); const labels=[...html.matchAll(/<label[\s\S]*?<\/label>/g)].map(m=>m[0]).filter(s=>s.includes('Puede tomar leads fuera de sus bloques'));
 expect(labels).toHaveLength(2); expect(labels.every(s=>!s.includes('checked='))).toBe(true); expect(html).toContain('No amplía su cola automática');
 });
 it('renders an existing grant without enabling backup or changing block selection',()=>{
 const html=render(true); const labels=[...html.matchAll(/<label[\s\S]*?<\/label>/g)].map(m=>m[0]);
 expect(labels.filter(s=>s.includes('Puede tomar leads fuera de sus bloques')).every(s=>s.includes('checked='))).toBe(true);
 expect(labels.filter(s=>s.includes('Respaldo')).every(s=>!s.includes('checked='))).toBe(true);
 });
});
