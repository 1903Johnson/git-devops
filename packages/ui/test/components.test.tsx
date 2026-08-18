import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Input, Select } from '../src/components.js';

describe('Button', () => {
  it('disables interaction while loading', async () => {
    const onClick = vi.fn();

    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole('button', {
      name: /loading\s*save/i,
    });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    await userEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it('respects the disabled prop', () => {
    render(<Button disabled>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('Input', () => {
  it('wires an announced error to its input', () => {
    render(<Input id="email" aria-label="Email" error="Email is required" />);

    const input = screen.getByRole('textbox', { name: 'Email' });

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Email is required');
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'email-error');
  });
});

describe('Select', () => {
  it('supports keyboard option selection', async () => {
    const onChange = vi.fn();

    render(
      <Select aria-label="Campus" onChange={onChange}>
        <option>Central</option>
        <option>North</option>
      </Select>,
    );

    const select = screen.getByRole('combobox', {
      name: 'Campus',
    });

    const user = userEvent.setup();

    await user.tab();

    expect(select).toHaveFocus();

    await user.selectOptions(select, 'North');

    expect(select).toHaveValue('North');
    expect(onChange).toHaveBeenCalled();
  });
});
