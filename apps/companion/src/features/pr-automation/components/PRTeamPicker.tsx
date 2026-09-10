import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';

import type { PRTeamProfile } from '@farmslot/protocol';

import { styles } from '../styles/pr-automation-styles';

import { PRButton, PRInput } from './PRControls';

export function PRTeamPicker({
  teams,
  value,
  onChange,
  disabled,
  allowAll = false,
  testPrefix = 'companion-pr-request',
}: {
  teams: PRTeamProfile[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  allowAll?: boolean;
  testPrefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  return (
    <View style={styles.card}>
      <PRButton
        label={
          teams.find((team) => team.id === value)?.config.name ??
          (allowAll ? 'All teams' : 'Choose team policy')
        }
        testID={`${testPrefix}-team-picker`}
        disabled={disabled}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <PRInput
            label="Find team"
            testID={`${testPrefix}-team-search`}
            value={search}
            disabled={disabled}
            onChange={setSearch}
          />
          <ScrollView
            nestedScrollEnabled
            style={styles.choices}
            keyboardShouldPersistTaps="handled"
          >
            {allowAll && (
              <PRButton
                label="All teams"
                disabled={disabled}
                selected={!value}
                onPress={() => {
                  onChange('');
                  setOpen(false);
                }}
              />
            )}
            {teams
              .filter((team) => team.config.name.toLowerCase().includes(search.toLowerCase()))
              .map((team) => (
                <PRButton
                  key={team.id}
                  testID={`${testPrefix}-team-${team.id}`}
                  label={team.config.name}
                  selected={team.id === value}
                  disabled={disabled}
                  onPress={() => {
                    onChange(team.id);
                    setOpen(false);
                  }}
                />
              ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}
