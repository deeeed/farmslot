import { Redirect, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function PullRequestsRedirect() {
  const params = useLocalSearchParams<{ pr?: string | string[]; repo?: string | string[] }>();
  return <Redirect href={{ pathname: '/(tabs)/prs', params }} />;
}
