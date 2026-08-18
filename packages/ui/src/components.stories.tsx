import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge, Button, Card, EmptyState, Input, Select, Spinner } from './components.js';
import './styles.css';

const meta = {
  title: 'Primitives',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const ButtonDefault: Story = {
  render: () => <Button>Save</Button>,
};

export const ButtonDisabled: Story = {
  render: () => <Button disabled>Disabled</Button>,
};

export const ButtonLoading: Story = {
  render: () => <Button loading>Saving</Button>,
};

export const ButtonFocusVisible: Story = {
  render: () => <Button autoFocus>Focused button</Button>,
};

export const InputDefault: Story = {
  render: () => <Input aria-label="Name" placeholder="Name" />,
};

export const InputError: Story = {
  render: () => <Input id="email" aria-label="Email" error="Enter a valid email" />,
};

export const SelectDefault: Story = {
  render: () => (
    <Select aria-label="Campus" defaultValue="">
      <option value="" disabled>
        Select campus
      </option>
      <option value="central">Central</option>
      <option value="north">North</option>
    </Select>
  ),
};

export const CardDefault: Story = {
  render: () => <Card>Card content</Card>,
};

export const BadgeDefault: Story = {
  render: () => <Badge>Active</Badge>,
};

export const SpinnerLoading: Story = {
  render: () => <Spinner label="Loading records" />,
};

export const EmptyStateDefault: Story = {
  render: () => (
    <EmptyState title="No records" action={<Button>Add record</Button>}>
      <p>New records will appear here.</p>
    </EmptyState>
  ),
};
