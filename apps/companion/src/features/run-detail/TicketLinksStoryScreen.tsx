import { ScrollView, Text, View } from 'react-native';

import type { Run } from '@farmslot/protocol';

import { RunLinkedTickets } from '../../components/RunLinkedTickets';
import { RunElapsedTime } from '../../components/RunPipeline';
import { fonts } from '../../lib/theme';

const capturedAt = Date.now();

/** Development-only layout proof of the production row component on both surfaces. */
export function TicketLinksStoryScreen() {
  if (!__DEV__) return null;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      {['#12121a', '#ffffff'].map((backgroundColor) => (
        <View key={backgroundColor} style={{ backgroundColor, padding: 12, gap: 20 }}>
          {[1, 6].map((count) => {
            const run: Run = {
              id: `inline-tickets-${count}`,
              familyId: `inline-tickets-${count}`,
              ticketOrPr: 'TEAM-100',
              linkedTicketRefs: Array.from({ length: count }, (_, index) => `TEAM-${100 + index}`),
              links: [{ label: 'Jira', url: 'https://tracker.example/browse/TEAM-100' }],
              flowType: 'dev',
              lane: 'production',
              project: 'fixture',
              status: count === 1 ? 'reviewing' : 'done',
              slotId: null,
              branch: 'fixture',
              taskFile: null,
              steps: [
                {
                  name: 'review',
                  status: count === 1 ? 'running' : 'done',
                  startedAt: new Date(capturedAt - 18 * 60000).toISOString(),
                },
              ],
              decisions: [],
              metrics: { runner: null, model: null, nudgeCount: 0 },
              createdAt: new Date(capturedAt - 134 * 60000).toISOString(),
              updatedAt: new Date(capturedAt).toISOString(),
              completedAt: count === 6 ? new Date(capturedAt).toISOString() : undefined,
            };
            return (
              <View key={count}>
                <RunLinkedTickets run={run} compact />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: fonts.sizeSm, color: '#8888a0' }}>
                    {count} covered ticket{count === 1 ? '' : 's'}
                  </Text>
                  <RunElapsedTime run={run} />
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}
