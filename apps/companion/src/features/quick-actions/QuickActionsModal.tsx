import React, { useEffect, useRef } from 'react';
import { Modal, type ModalProps, View } from 'react-native';

import type { CompanionViewLocation } from '@farmslot/protocol/surfaces/view-links';

import { FloatingQuickActions } from './FloatingQuickActions';
import { useOptionalQuickActions } from './quick-actions-context';

interface QuickActionsModalProps extends Omit<ModalProps, 'onRequestClose'> {
  onRequestClose?: () => void;
  sharedView?: CompanionViewLocation;
}

const unavailableOverlay: CompanionViewLocation = { pathname: '/unmapped-overlay', params: {} };

function ModalOutlet({
  sharedView,
  close,
}: {
  sharedView?: CompanionViewLocation;
  close?: () => void;
}) {
  const context = useOptionalQuickActions();
  const owner = useRef(Symbol('modal quick actions')).current;
  const register = context?.registerOutlet;
  useEffect(() => register?.(owner), [owner, register]);
  if (!context || context.activeOutlet !== owner) return null;
  return <FloatingQuickActions selection={sharedView ?? unavailableOverlay} beforeVoice={close} />;
}

/** Routes the one shared control into the native modal's window. */
export function QuickActionsModal({
  children,
  sharedView,
  onRequestClose,
  ...props
}: QuickActionsModalProps) {
  return (
    <Modal {...props} onRequestClose={onRequestClose}>
      <View style={{ flex: 1 }}>
        {children}
        <ModalOutlet sharedView={sharedView} close={onRequestClose} />
      </View>
    </Modal>
  );
}
