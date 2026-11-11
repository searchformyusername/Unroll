import {describe,expect,it} from 'vitest';
import {groupTogether,moveToGroup,readGroups,removeFromGroups} from '../src/groups';
describe('trajectory grouping',()=>{
 it('creates Group A with both trajectories and requests focused rename',()=>{expect(groupTogether([],'a','b','new')).toEqual({createdId:'new',groups:[{id:'new',name:'Group A',runIds:['b','a']}]});});
 it('adds to the target group and removes membership in the previous group',()=>{const groups=[{id:'one',name:'Runs',runIds:['a','b']},{id:'two',name:'More',runIds:['c','d']}];expect(groupTogether(groups,'a','c','unused').groups).toEqual([{id:'one',name:'Runs',runIds:['b']},{id:'two',name:'More',runIds:['c','d','a']}]);});
 it('does not duplicate a trajectory in the same group or form a group with itself',()=>{const groups=[{id:'g',name:'Group A',runIds:['a','b']}];expect(groupTogether(groups,'a','a','x').groups).toBe(groups);expect(moveToGroup(groups,'a','g')[0].runIds).toEqual(['b','a']);});
 it('preserves trajectories when ungrouped and removes empty group shells',()=>{expect(removeFromGroups([{id:'g',name:'A',runIds:['a']}],'a')).toEqual([]);expect(removeFromGroups([{id:'g',name:'A',runIds:['a','b']}],'a')[0].runIds).toEqual(['b']);});
 it('uses the next available default name',()=>{expect(groupTogether([{id:'g',name:'Group A',runIds:['x','y']}],'a','b','new').groups[1].name).toBe('Group B');});
 it('loads only valid, unique groups and memberships from storage',()=>{const groups=readGroups(JSON.stringify([{id:'g',name:'A',runIds:['a','a',123]},{id:'g',name:'Duplicate',runIds:['x']},{id:'h',name:'B',runIds:['a','b']} ]));expect(groups).toEqual([{id:'g',name:'A',runIds:['a']},{id:'h',name:'B',runIds:['b']}]);expect(readGroups('{bad')).toEqual([]);expect(readGroups('null')).toEqual([]);});
});
