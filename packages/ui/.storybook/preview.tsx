import type { Preview } from '@storybook/react-vite';
import { themeCss } from '@church/ui-tokens';
import '../src/styles.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Theme',
      defaultValue: 'light',
      toolbar: {
        icon: 'paintbrush',
        items: ['light', 'dark'],
      },
    },
  },
  decorators: [
    (Story, context) => (
      <div
        data-theme={context.globals.theme}
        style={{
          background: 'var(--church-color-surface)',
          color: 'var(--church-color-text-primary)',
          padding: 'var(--church-spacing-xl)',
        }}
      >
        <style>{themeCss}</style>
        <Story />
      </div>
    ),
  ],
};

export default preview;
