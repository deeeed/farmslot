import { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  type InteractiveOperatorPacket,
  Methods,
  type Run,
  validateInteractiveOperatorPacket,
} from '@farmslot/protocol';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactUrl,
} from '../../../lib/artifact-url';
import type { GatewayClient } from '../../../lib/gateway-client';
import { gatewayFetch } from '../../../lib/gateway-http-auth';
import {
  collectRunInteractivePacketArtifacts,
  interactivePacketActionRequest,
  interactivePacketArtifactKey,
  interactivePacketArtifactOpenUrl,
} from '../../../lib/interactive-operator-packets';
import { colors, fonts, radii, spacing } from '../../../lib/theme';

interface LoadedInteractivePacket {
  artifact: ArtifactManifestEntry;
  packet?: InteractiveOperatorPacket;
  bodyText?: string;
  error?: string;
}

export function InteractiveOperatorPacketsPanel({
  run,
  client,
  gatewayUrl,
  artifactAuthHeaders,
}: {
  run: Run;
  client: GatewayClient | null;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
}) {
  const packetArtifacts = collectRunInteractivePacketArtifacts(run);
  const packetArtifactKey = interactivePacketArtifactKey(packetArtifacts);
  const [packets, setPackets] = useState<LoadedInteractivePacket[]>([]);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    if (!packetArtifacts.length) {
      setPackets([]);
      setFeedback(null);
      setLoading(false);
      return;
    }
    const readArtifactText = async (path: string): Promise<string> => {
      const response = await gatewayFetch(
        artifactUrl(gatewayUrl, run.id, path),
        artifactAuthHeaders,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    };
    setLoading(true);
    Promise.all(
      packetArtifacts.map(async (artifact): Promise<LoadedInteractivePacket> => {
        try {
          const parsed = parseJson(await readArtifactText(artifact.path));
          const validation = validateInteractiveOperatorPacket(parsed);
          if (!validation.ok || !validation.packet) {
            return { artifact, error: validation.errors.join('; ') || 'Invalid packet' };
          }
          const packet = validation.packet;
          const bodyText = packet.body.path
            ? await readArtifactText(packet.body.path)
            : packet.body.text;
          return { artifact, packet, bodyText };
        } catch (error) {
          return { artifact, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    )
      .then((loaded) => {
        if (!disposed) setPackets(loaded);
      })
      .catch((error: Error) => {
        if (!disposed) setFeedback(`Packet load failed: ${error.message}`);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [artifactAuthHeaders, gatewayUrl, packetArtifactKey, run.id]);

  if (!packetArtifacts.length && !loading) return null;

  const runAction = async (packet: InteractiveOperatorPacket, actionId: string) => {
    const action = packet.actions?.find((candidate) => candidate.id === actionId);
    if (!action) return;
    const request = interactivePacketActionRequest(action);
    if (!request) {
      setFeedback(`Action "${action.label}" is missing required payload fields.`);
      return;
    }
    const requiresConfirmation =
      action.safety === 'operator-confirmed' ||
      request.kind === 'terminal.send' ||
      request.kind === 'decision.resolve';
    if (requiresConfirmation && !(await confirmAction(action.label, packet.title))) return;
    try {
      if (request.kind === 'copy') {
        const shareResult = await Share.share({ message: request.text });
        if (shareResult.action === Share.dismissedAction) return;
        if (Platform.OS === 'android') {
          setFeedback(`Share sheet opened for "${action.label}".`);
          return;
        }
      } else if (request.kind === 'open-artifact') {
        await Linking.openURL(
          interactivePacketArtifactOpenUrl(
            gatewayUrl,
            run.id,
            request.artifactPath,
            artifactAuthHeaders,
          ),
        );
      } else if (request.kind === 'terminal.send') {
        if (!client) throw new Error('Gateway is not connected.');
        if (!run.slotId) throw new Error('Run is not attached to a slot.');
        await client.request(Methods.TERMINAL_SEND, {
          slotId: run.slotId,
          runId: run.id,
          text: request.text,
          enter: true,
        });
      } else if (request.kind === 'decision.resolve') {
        if (!client) throw new Error('Gateway is not connected.');
        await client.request(Methods.RUN_RESOLVE_DECISION, {
          runId: run.id,
          decisionId: request.decisionId,
          actionId: request.actionId,
        });
      }
      setFeedback(`Completed "${action.label}".`);
    } catch (error) {
      setFeedback(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <View style={panelStyles.card}>
      <View style={panelStyles.header}>
        <View style={panelStyles.headerText}>
          <Text style={panelStyles.title}>Interactive packets</Text>
          <Text style={panelStyles.summary}>
            Agent-authored review cards with anchors and confirmed actions.
          </Text>
        </View>
        <Text style={panelStyles.badge}>{loading ? 'loading' : packets.length}</Text>
      </View>
      {packets.map((entry) => {
        const packet = entry.packet;
        return packet ? (
          <View key={entry.artifact.path} style={panelStyles.packet}>
            <View style={panelStyles.header}>
              <View style={panelStyles.headerText}>
                <Text style={panelStyles.packetTitle}>{packet.title}</Text>
                {packet.summary ? <Text style={panelStyles.summary}>{packet.summary}</Text> : null}
              </View>
              <Text style={panelStyles.intent}>{packet.intent}</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={panelStyles.body}>{entry.bodyText ?? packet.body.text ?? ''}</Text>
            </ScrollView>
            {packet.anchors?.length ? (
              <View style={panelStyles.chipRow}>
                {packet.anchors.map((anchor) => {
                  const label = `${anchor.label}${anchor.line ? `:${anchor.line}` : ''}`;
                  const artifactPath = anchor.artifactPath;
                  return artifactPath ? (
                    <Pressable
                      key={anchor.id}
                      style={panelStyles.chip}
                      onPress={() =>
                        void Linking.openURL(
                          interactivePacketArtifactOpenUrl(
                            gatewayUrl,
                            run.id,
                            artifactPath,
                            artifactAuthHeaders,
                          ),
                        )
                      }
                    >
                      <Text style={panelStyles.chipText} numberOfLines={1}>
                        {label}
                      </Text>
                    </Pressable>
                  ) : (
                    <View key={anchor.id} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText} numberOfLines={1}>
                        {label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}
            {packet.actions?.length ? (
              <View style={panelStyles.chipRow}>
                {packet.actions.map((action) => (
                  <Pressable
                    key={action.id}
                    style={panelStyles.action}
                    onPress={() => void runAction(packet, action.id)}
                  >
                    <Text style={panelStyles.actionText}>{action.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <View key={entry.artifact.path} style={[panelStyles.packet, panelStyles.errorPacket]}>
            <Text style={panelStyles.packetTitle}>Invalid interactive packet</Text>
            <Text style={panelStyles.summary}>{entry.artifact.path}</Text>
            <Text style={panelStyles.errorText}>{entry.error}</Text>
          </View>
        );
      })}
      {feedback ? <Text style={panelStyles.feedback}>{feedback}</Text> : null}
    </View>
  );
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function confirmAction(label: string, title: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert('Run packet action?', `Run "${label}" for "${title}"?`, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Run', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}

const panelStyles = StyleSheet.create({
  action: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '66',
    borderRadius: radii.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  badge: {
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  body: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
    minWidth: 260,
    paddingVertical: spacing.xs,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '44',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.xl,
    padding: spacing.lg,
  },
  chip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.sm,
    borderWidth: 1,
    maxWidth: 180,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  errorPacket: {
    borderColor: colors.statusFail + '55',
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeXs,
  },
  feedback: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  intent: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  packet: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  packetTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  summary: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
});
