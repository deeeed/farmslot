import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';

import { PRButton, PRToggle } from './components/PRControls';
import { PRForms } from './components/PRForms';
import { PRMonitorCards } from './components/PRMonitorCards';
import { PRPushCard } from './components/PRPushCard';
import { PRReviewCards } from './components/PRReviewCards';
import { PRRuleCards } from './components/PRRuleCards';
import { PRTeamPicker } from './components/PRTeamPicker';
import { styles } from './styles/pr-automation-styles';
import type { PRAutomationController } from './use-pr-automation-controller';

export function PRAutomationScreen(screen: PRAutomationController) {
  const { viewModel: vm, actions } = screen;
  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        key={`${vm.tab}:${vm.focusedMonitorId ?? ''}:${vm.focusedNotificationId ?? ''}:${vm.linkVisit}`}
        testID="companion-pr-automation"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.row}>
          <Text style={styles.title}>PR monitoring and reviews</Text>
          <PRButton
            label={vm.loading ? 'Refreshing…' : 'Refresh queue'}
            disabled={!vm.connected || vm.loading || vm.busy}
            onPress={actions.refresh}
          />
        </View>
        {!vm.connected && (
          <Text style={styles.attention}>Reconnect to the gateway to load current PR work.</Text>
        )}
        {[vm.error, vm.actionError, vm.watches.schedulerError, vm.reviews.schedulerError]
          .filter(Boolean)
          .map((error, index) => (
            <Text
              key={index}
              accessibilityRole="alert"
              testID="companion-pr-error"
              style={styles.error}
            >
              {error}
            </Text>
          ))}
        <View style={styles.row}>
          {(['monitors', 'reviews', 'rules', 'policies', 'attention'] as const).map((tab) => (
            <PRButton
              key={tab}
              testID={`companion-pr-tab-${tab}`}
              label={
                {
                  monitors: 'Monitors',
                  reviews: 'Reviews',
                  rules: 'Rules',
                  policies: 'Project defaults',
                  attention: 'Notifications',
                }[tab]
              }
              selected={vm.tab === tab}
              disabled={vm.busy}
              onPress={() => actions.setTab(tab)}
            />
          ))}
        </View>
        {!vm.editor && (
          <>
            <Text style={styles.muted}>Team filter</Text>
            <PRTeamPicker
              teams={vm.reviews.teams}
              value={vm.teamId}
              onChange={actions.setTeamId}
              disabled={vm.disabled}
              allowAll
              testPrefix="companion-pr-filter"
            />
            <PRToggle
              label="Show history"
              testID="companion-pr-history"
              value={vm.history}
              onChange={actions.setHistory}
            />
          </>
        )}
        <PRForms {...screen} />

        {!vm.editor &&
          (vm.tab === 'monitors' ? (
            <PRMonitorCards {...screen} />
          ) : vm.tab === 'reviews' ? (
            <PRReviewCards {...screen} />
          ) : vm.tab === 'rules' ? (
            <PRRuleCards {...screen} />
          ) : vm.tab === 'attention' ? (
            <PRPushCard {...screen} />
          ) : (
            <>
              <Text style={styles.muted}>Publication monitoring is opt-in for each project.</Text>
              <PRButton
                label="Configure a project"
                disabled={vm.disabled}
                onPress={() => actions.openPolicy()}
              />
              {(vm.watches.projectPolicies ?? []).map((policy) => (
                <View key={policy.project} style={styles.card}>
                  <Text style={styles.title}>{policy.project}</Text>
                  <Text style={styles.text}>
                    {policy.enabled ? 'Enabled for new publications' : 'Disabled'} ·{' '}
                    {policy.config.policy.mode}
                  </Text>
                  {vm.watches.publicationErrors?.[policy.project] && (
                    <Text style={styles.error}>{vm.watches.publicationErrors[policy.project]}</Text>
                  )}
                  <PRButton
                    label="Configure"
                    disabled={vm.disabled}
                    onPress={() => actions.openPolicy(policy)}
                  />
                </View>
              ))}
            </>
          ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
